'use strict';

/* =====================================================================
   Sala Simples — chat, voz, tela e arquivos P2P (PeerJS / WebRTC)

   Como funciona, sem servidor próprio:
   - Cada sala tem até MAX_SLOTS vagas. O ID de cada vaga é
     "<PREFIXO><sala>-<número>". Quem entra tenta a vaga 1; se estiver
     ocupada, tenta a 2, e assim por diante.
   - Depois de entrar, a pessoa tenta se conectar a todas as outras vagas.
     Vagas vazias dão erro "peer-unavailable", que é ignorado.
   - Cada par de pessoas tem 1 conexão de dados (chat e arquivos) e,
     opcionalmente, chamadas de mídia (voz e tela).
   - O servidor público do PeerJS só ajuda a apresentar os navegadores.
     Mensagens, arquivos e áudio/vídeo não passam por ele.
   ===================================================================== */

const MAX_SLOTS = 6;                 // máximo de pessoas por sala
const PREFIXO = 'salasimples-v1-';   // evita colisão com outros apps no servidor do PeerJS
const TAMANHO_PEDACO = 64 * 1024;    // tamanho de cada pedaço de arquivo
const BUFFER_MAX = 4 * 1024 * 1024;  // pausa o envio se o buffer passar disso

// Servidores STUN/TURN. Se algumas conexões falharem (redes restritivas),
// adicione um servidor TURN aqui. Veja o README.
const CONFIG_PEER = {
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
      // { urls: 'turn:SEU_SERVIDOR:3478', username: 'usuario', credential: 'senha' }
    ]
  }
};

const $ = (id) => document.getElementById(id);

let peer = null;        // meu Peer
let meuSlot = 0;
let sala = '';
let meuNome = '';
let micStream = null;
let telaStream = null;

// id do outro peer -> { id, nome, conn, saida: {voice, screen}, anunciado }
const pares = new Map();
// arquivos sendo recebidos: "peerId:idArquivo" -> {...}
const recebendo = new Map();

/* ---------------------------- Utilidades ---------------------------- */

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

function formatarTamanho(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 ** 2) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 ** 3) return (bytes / 1024 ** 2).toFixed(1) + ' MB';
  return (bytes / 1024 ** 3).toFixed(2) + ' GB';
}

function rolarChat() {
  const m = $('mensagens');
  m.scrollTop = m.scrollHeight;
}

function sistema(texto) {
  const d = document.createElement('div');
  d.className = 'msg sistema';
  d.textContent = texto;
  $('mensagens').appendChild(d);
  rolarChat();
}

function adicionarMensagem(autor, texto, propria) {
  const d = document.createElement('div');
  d.className = 'msg' + (propria ? ' propria' : '');
  const a = document.createElement('strong');
  a.textContent = autor;
  const t = document.createElement('span');
  t.textContent = texto; // textContent evita injeção de HTML
  d.append(a, t);
  $('mensagens').appendChild(d);
  rolarChat();
}

function atualizarPessoas() {
  const nomes = [meuNome + ' (você)'];
  pares.forEach((p) => nomes.push(p.nome));
  $('pessoas').textContent = nomes.join(', ');
}

function atualizarPalcoVazio() {
  $('vazio').hidden = $('videos').children.length > 0;
}

function transmitir(mensagem) {
  pares.forEach((p) => {
    if (p.conn && p.conn.open) p.conn.send(mensagem);
  });
}

/* --------------------------- Entrar na sala --------------------------- */

function entrar() {
  meuNome = $('nome').value.trim() || 'Anônimo';
  sala = $('codigo').value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (!sala) {
    alert('Digite um código de sala (letras, números e hífen).');
    return;
  }
  location.hash = sala;
  $('entrada').hidden = true;
  $('app').hidden = false;
  $('sala-nome').textContent = sala;
  $('status').textContent = 'Conectando...';
  abrirPeer(1);
}

function abrirPeer(slot) {
  if (slot > MAX_SLOTS) {
    $('status').textContent = 'Sala cheia.';
    sistema('A sala está cheia (máximo de ' + MAX_SLOTS + ' pessoas).');
    return;
  }

  const p = new Peer(PREFIXO + sala + '-' + slot, CONFIG_PEER);

  p.on('open', () => {
    peer = p;
    meuSlot = slot;
    $('status').textContent = 'Conectado';
    atualizarPessoas();
    sistema('Você entrou na sala.');

    p.on('connection', (conn) => registrarConexao(conn, false));
    p.on('call', receberChamada);
    p.on('disconnected', () => {
      $('status').textContent = 'Reconectando...';
      p.reconnect();
    });

    // Tenta falar com todas as outras vagas
    for (let i = 1; i <= MAX_SLOTS; i++) {
      if (i !== slot) conectar(PREFIXO + sala + '-' + i);
    }
  });

  p.on('error', (err) => {
    if (err.type === 'unavailable-id') {
      p.destroy();
      abrirPeer(slot + 1); // vaga ocupada, tenta a próxima
    } else if (err.type === 'peer-unavailable') {
      // vaga vazia: normal, ignora
    } else {
      console.error(err);
      $('status').textContent = 'Erro: ' + err.type;
    }
  });
}

function conectar(idRemoto) {
  if (pares.has(idRemoto)) return;
  const conn = peer.connect(idRemoto, { reliable: true, metadata: { slot: meuSlot } });
  registrarConexao(conn, true);
}

/* ------------------------ Conexão de dados (chat) ------------------------ */

// Quem iniciou a conexão? Usado para resolver conexões duplicadas quando
// duas pessoas entram ao mesmo tempo: ambos mantêm a iniciada pela menor vaga.
function slotIniciador(conn) {
  if (conn.souIniciador) return meuSlot;
  return conn.metadata && conn.metadata.slot ? conn.metadata.slot : 99;
}

function registrarConexao(conn, souIniciador) {
  conn.souIniciador = souIniciador;
  const id = conn.peer;

  conn.on('open', () => {
    let par = pares.get(id);

    if (par && par.conn !== conn && par.conn.open) {
      if (slotIniciador(conn) < slotIniciador(par.conn)) {
        const velha = par.conn;
        par.conn = conn;
        velha.close();
      } else {
        conn.close();
        return;
      }
    } else if (!par) {
      par = { id, nome: 'Alguém', conn, saida: {}, anunciado: false };
      pares.set(id, par);
      // Se já estou na voz ou transmitindo tela, inclui a nova pessoa
      if (micStream) chamar(par, 'voice');
      if (telaStream) chamar(par, 'screen');
    } else {
      par.conn = conn;
    }

    conn.send({ t: 'hello', nome: meuNome });
    atualizarPessoas();
  });

  conn.on('data', (d) => receberDados(conn, d));

  conn.on('close', () => {
    const par = pares.get(id);
    if (par && par.conn === conn) removerPar(id);
  });

  conn.on('error', (e) => console.error('Erro na conexão', e));
}

function removerPar(id) {
  const par = pares.get(id);
  if (!par) return;
  Object.values(par.saida).forEach((c) => c && c.close());
  removerMidia(id, 'voice');
  removerMidia(id, 'screen');

  // Transferências em andamento desse par falharam
  recebendo.forEach((r, chave) => {
    if (chave.startsWith(id + ':')) {
      r.t.textContent = 'Falha ao receber (' + r.nome + '): a pessoa saiu.';
      r.bar.remove();
      recebendo.delete(chave);
    }
  });

  pares.delete(id);
  if (par.anunciado) sistema(par.nome + ' saiu da sala.');
  atualizarPessoas();
}

function receberDados(conn, d) {
  const par = pares.get(conn.peer);
  if (!par || !d) return;

  switch (d.t) {
    case 'hello':
      par.nome = d.nome || 'Anônimo';
      if (!par.anunciado) {
        par.anunciado = true;
        sistema(par.nome + ' entrou na sala.');
      }
      atualizarPessoas();
      break;
    case 'msg':
      adicionarMensagem(par.nome, d.texto, false);
      break;
    case 'voz-parou':
      removerMidia(par.id, 'voice');
      break;
    case 'tela-parou':
      removerMidia(par.id, 'screen');
      break;
    case 'arq-ini':
      iniciarRecepcao(par, d);
      break;
    case 'arq-parte':
      receberParte(par, d);
      break;
    case 'arq-fim':
      finalizarRecepcao(par, d);
      break;
  }
}

/* -------------------------------- Chat -------------------------------- */

$('form').addEventListener('submit', (e) => {
  e.preventDefault();
  const texto = $('texto').value.trim();
  if (!texto) return;
  adicionarMensagem(meuNome, texto, true);
  transmitir({ t: 'msg', texto });
  $('texto').value = '';
});

/* ------------------------- Transferência de arquivos ------------------------- */

function criarItemArquivo(texto) {
  const el = document.createElement('div');
  el.className = 'msg arquivo';
  const t = document.createElement('span');
  t.textContent = texto;
  const bar = document.createElement('progress');
  bar.max = 1;
  bar.value = 0;
  el.append(t, bar);
  $('mensagens').appendChild(el);
  rolarChat();
  return { el, t, bar };
}

async function enviarParaUm(par, arquivo, id, aoProgredir) {
  const conn = par.conn;
  conn.send({ t: 'arq-ini', id, nome: arquivo.name, tamanho: arquivo.size, tipo: arquivo.type });

  let posicao = 0;
  while (posicao < arquivo.size) {
    const fim = Math.min(posicao + TAMANHO_PEDACO, arquivo.size);
    const dados = await arquivo.slice(posicao, fim).arrayBuffer();

    // Controle de fluxo: espera o buffer esvaziar antes de mandar mais
    while (conn.open && (conn.dataChannel ? conn.dataChannel.bufferedAmount : 0) + (conn.bufferSize || 0) > BUFFER_MAX) {
      await esperar(50);
    }
    if (!conn.open) throw new Error('desconectou');

    conn.send({ t: 'arq-parte', id, dados });
    posicao = fim;
    aoProgredir(posicao);
  }
  conn.send({ t: 'arq-fim', id });
}

async function enviarArquivo(arquivo) {
  const alvos = [...pares.values()].filter((p) => p.conn && p.conn.open);
  if (!alvos.length) {
    sistema('Ninguém na sala para receber o arquivo.');
    return;
  }

  const id = Math.random().toString(36).slice(2);
  const ui = criarItemArquivo('Enviando ' + arquivo.name + ' (' + formatarTamanho(arquivo.size) + ')');
  const progresso = new Map();

  await Promise.all(alvos.map(async (par) => {
    try {
      await enviarParaUm(par, arquivo, id, (pos) => {
        progresso.set(par.id, pos);
        ui.bar.value = Math.min(...progresso.values()) / arquivo.size;
      });
    } catch (e) {
      sistema('Falha ao enviar para ' + par.nome + '.');
    }
  }));

  ui.t.textContent = 'Enviado: ' + arquivo.name + ' (' + formatarTamanho(arquivo.size) + ')';
  ui.bar.remove();
}

$('arquivo').addEventListener('change', (e) => {
  const arquivo = e.target.files[0];
  e.target.value = '';
  if (arquivo) enviarArquivo(arquivo);
});

function iniciarRecepcao(par, d) {
  const ui = criarItemArquivo(par.nome + ' está enviando ' + d.nome + ' (' + formatarTamanho(d.tamanho) + ')');
  recebendo.set(par.id + ':' + d.id, {
    nome: d.nome, tamanho: d.tamanho, tipo: d.tipo, partes: [], recebido: 0,
    el: ui.el, t: ui.t, bar: ui.bar
  });
}

function receberParte(par, d) {
  const r = recebendo.get(par.id + ':' + d.id);
  if (!r) return;
  r.partes.push(d.dados);
  r.recebido += d.dados.byteLength;
  r.bar.value = r.tamanho ? r.recebido / r.tamanho : 1;
}

function finalizarRecepcao(par, d) {
  const chave = par.id + ':' + d.id;
  const r = recebendo.get(chave);
  if (!r) return;
  recebendo.delete(chave);

  const blob = new Blob(r.partes, { type: r.tipo || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = r.nome;
  link.textContent = 'Baixar ' + r.nome + ' (' + formatarTamanho(r.tamanho) + ') de ' + par.nome;

  r.bar.remove();
  r.t.replaceWith(link);
}

/* --------------------------- Voz e tela (mídia) --------------------------- */

// Chamada de saída: eu mando minha voz ou minha tela para um par.
function chamar(par, tipo) {
  const stream = tipo === 'voice' ? micStream : telaStream;
  if (!stream || !peer) return;
  const call = peer.call(par.id, stream, { metadata: { tipo } });
  par.saida[tipo] = call;
}

// Chamada de entrada: apenas recebo (não mando nada de volta nessa chamada).
function receberChamada(call) {
  const tipo = (call.metadata && call.metadata.tipo) || 'voice';
  call.answer();
  call.on('stream', (stream) => mostrarMidia(call.peer, tipo, stream));
  call.on('close', () => removerMidia(call.peer, tipo));
  call.on('error', (e) => console.error('Erro na chamada', e));
}

function mostrarMidia(idPar, tipo, stream) {
  const chave = idPar + '-' + tipo;
  const par = pares.get(idPar);
  const nome = par ? par.nome : 'Alguém';

  if (tipo === 'voice') {
    let audio = document.querySelector('audio[data-chave="' + chave + '"]');
    if (!audio) {
      audio = document.createElement('audio');
      audio.dataset.chave = chave;
      audio.autoplay = true;
      $('audios').appendChild(audio);
    }
    audio.srcObject = stream;
    audio.play().catch(() => {});
    return;
  }

  // tela
  let fig = document.querySelector('figure[data-chave="' + chave + '"]');
  if (!fig) {
    fig = document.createElement('figure');
    fig.dataset.chave = chave;
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.controls = true;
    const legenda = document.createElement('figcaption');
    legenda.textContent = 'Tela de ' + nome;
    fig.append(video, legenda);
    $('videos').appendChild(fig);
  }
  const v = fig.querySelector('video');
  v.srcObject = stream;
  v.play().catch(() => {});
  atualizarPalcoVazio();
}

function removerMidia(idPar, tipo) {
  const chave = idPar + '-' + tipo;
  document.querySelectorAll('[data-chave="' + chave + '"]').forEach((el) => el.remove());
  atualizarPalcoVazio();
}

/* ---- Voz ---- */

async function entrarNaVoz() {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
  } catch (e) {
    sistema('Não foi possível acessar o microfone (permissão negada ou sem dispositivo).');
    return;
  }
  pares.forEach((par) => chamar(par, 'voice'));
  $('btn-voz').textContent = '📴 Sair da voz';
  $('btn-voz').classList.add('ativo');
  $('btn-mudo').disabled = false;
  sistema('Você entrou na voz.');
}

function sairDaVoz() {
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  micStream = null;
  pares.forEach((par) => {
    if (par.saida.voice) par.saida.voice.close();
    par.saida.voice = null;
  });
  transmitir({ t: 'voz-parou' });
  $('btn-voz').textContent = '🎤 Entrar na voz';
  $('btn-voz').classList.remove('ativo');
  $('btn-mudo').disabled = true;
  $('btn-mudo').textContent = 'Silenciar';
}

$('btn-voz').addEventListener('click', () => (micStream ? sairDaVoz() : entrarNaVoz()));

$('btn-mudo').addEventListener('click', () => {
  if (!micStream) return;
  const faixa = micStream.getAudioTracks()[0];
  faixa.enabled = !faixa.enabled;
  $('btn-mudo').textContent = faixa.enabled ? 'Silenciar' : 'Reativar microfone';
});

/* ---- Tela ---- */

async function compartilharTela() {
  try {
    telaStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  } catch (e) {
    sistema('Compartilhamento de tela cancelado ou não permitido.');
    return;
  }
  // Se a pessoa parar pelo botão do próprio navegador
  telaStream.getVideoTracks()[0].addEventListener('ended', pararTela);

  pares.forEach((par) => chamar(par, 'screen'));

  // Prévia local
  const fig = document.createElement('figure');
  fig.dataset.chave = 'eu-screen';
  const video = document.createElement('video');
  video.autoplay = true;
  video.muted = true; // evita eco do próprio áudio
  video.playsInline = true;
  video.srcObject = telaStream;
  const legenda = document.createElement('figcaption');
  legenda.textContent = 'Sua tela (prévia)';
  fig.append(video, legenda);
  $('videos').appendChild(fig);
  atualizarPalcoVazio();

  $('btn-tela').textContent = '⏹️ Parar de compartilhar';
  $('btn-tela').classList.add('ativo');
}

function pararTela() {
  if (!telaStream) return;
  telaStream.getTracks().forEach((t) => t.stop());
  telaStream = null;
  pares.forEach((par) => {
    if (par.saida.screen) par.saida.screen.close();
    par.saida.screen = null;
  });
  transmitir({ t: 'tela-parou' });
  removerMidia('eu', 'screen');
  $('btn-tela').textContent = '🖥️ Compartilhar tela';
  $('btn-tela').classList.remove('ativo');
}

$('btn-tela').addEventListener('click', () => (telaStream ? pararTela() : compartilharTela()));

/* ------------------------------ Tela inicial ------------------------------ */

$('btn-entrar').addEventListener('click', entrar);
$('codigo').addEventListener('keydown', (e) => { if (e.key === 'Enter') entrar(); });
$('nome').addEventListener('keydown', (e) => { if (e.key === 'Enter') entrar(); });

$('btn-gerar').addEventListener('click', () => {
  $('codigo').value = 'sala-' + Math.random().toString(36).slice(2, 8);
});

$('btn-copiar').addEventListener('click', async () => {
  const link = location.origin + location.pathname + '#' + sala;
  try {
    await navigator.clipboard.writeText(link);
    sistema('Link copiado: ' + link);
  } catch (e) {
    prompt('Copie o link da sala:', link);
  }
});

// Se o link já veio com #codigo, preenche o campo
if (location.hash.length > 1) {
  $('codigo').value = decodeURIComponent(location.hash.slice(1));
}

window.addEventListener('beforeunload', () => {
  if (peer) peer.destroy();
});
