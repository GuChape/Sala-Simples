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

// Uma cor por vaga da sala (6 vagas = 6 cores). Como cada vaga só pode ser
// ocupada por uma pessoa, ninguém na mesma sala repete cor, e a cor volta a
// ficar livre quando a pessoa sai. Salas diferentes não interferem entre si.
const PALETA = ['#f87171', '#fb923c', '#facc15', '#4ade80', '#38bdf8', '#c084fc'];

// Emoji sorteado para cada pessoa ao entrar.
const EMOJIS = ['🐶', '🐱', '🦊', '🐼', '🐸', '🐵', '🦁', '🐯', '🐨', '🐙',
  '🦄', '🐢', '🦉', '🐧', '🦋', '🐳', '🦖', '🐝', '🦔', '🐰'];

// ---- Qualidade do áudio (codec Opus) ----
// Por padrão o navegador codifica a voz a ~32 kbps. Aqui pedimos mais bitrate,
// correção de erros (FEC) e que o som não seja cortado nos silêncios (DTX).
const OPUS = {
  voice:  { stereo: false, bitrate: 64000 },   // voz: mono, 64 kbps
  screen: { stereo: true,  bitrate: 128000 }   // som da transmissão: estéreo, 128 kbps
};

// ---- Qualidade da transmissão de tela ----
// largura/altura máximas, quadros por segundo, bitrate máximo (bits/s),
// dica de conteúdo e o que sacrificar se a internet apertar.
const QUALIDADES_TELA = {
  fluida:      { largura: 1280, altura: 720,  fps: 60, bitrate: 4000000, dica: 'motion', prioridade: 'maintain-framerate' },
  equilibrada: { largura: 1920, altura: 1080, fps: 60, bitrate: 8000000, dica: 'motion', prioridade: 'balanced' },
  nitida:      { largura: 1920, altura: 1080, fps: 30, bitrate: 6000000, dica: 'detail', prioridade: 'maintain-resolution' }
};

const $ = (id) => document.getElementById(id);

let peer = null;        // meu Peer
let meuSlot = 0;
let sala = '';
let meuNome = '';
let micStream = null;
let telaStream = null;
let meuEmoji = '🙂';
let qualidadeTela = 'equilibrada';

// conexões que tentei abrir e ainda não responderam: id -> timer de aviso
const pendentes = new Map();

// id do outro peer -> { id, nome, emoji, cor, conn, saida: {voice, screen}, naVoz, anunciado }
// saida = chamadas de mídia que EU enviei para essa pessoa
// naVoz = essa pessoa está no Voice chat?
const pares = new Map();
// chamadas de mídia que estou RECEBENDO: "peerId-voice" / "peerId-screen" -> chamada
const entradas = new Map();
// arquivos sendo recebidos: "peerId:idArquivo" -> {...}
const recebendo = new Map();

/* ---------------------------- Utilidades ---------------------------- */

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

function corDoSlot(slot) {
  return PALETA[(slot - 1) % PALETA.length];
}

// O número da vaga é o final do ID do peer: "<prefixo><sala>-<vaga>"
function corDoId(id) {
  return corDoSlot(parseInt(id.split('-').pop(), 10) || 1);
}

// Ordem aleatória das vagas, para a cor de cada pessoa ser sorteada
function ordemAleatoriaDeVagas() {
  const v = Array.from({ length: MAX_SLOTS }, (_, i) => i + 1);
  for (let i = v.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [v[i], v[j]] = [v[j], v[i]];
  }
  return v;
}

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

function adicionarMensagem(autor, texto, propria, cor, emoji) {
  const d = document.createElement('div');
  d.className = 'msg' + (propria ? ' propria' : '');
  const a = document.createElement('strong');
  a.textContent = (emoji ? emoji + ' ' : '') + autor;
  if (cor) a.style.color = cor;
  const t = document.createElement('span');
  t.textContent = texto; // textContent evita injeção de HTML
  d.append(a, t);
  $('mensagens').appendChild(d);
  rolarChat();
}

function atualizarPessoas() {
  const el = $('pessoas');
  el.textContent = '';
  const lista = [{ nome: meuNome + ' (você)', emoji: meuEmoji, cor: corDoSlot(meuSlot), naVoz: !!micStream }];
  pares.forEach((p) => lista.push(p));
  lista.forEach((p, i) => {
    if (i) el.append(', ');
    const s = document.createElement('span');
    // 🎙️ ao lado de quem está no Voice chat
    s.textContent = p.emoji + ' ' + p.nome + (p.naVoz ? ' 🎙️' : '');
    s.style.color = p.cor;
    el.appendChild(s);
  });
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
  meuEmoji = EMOJIS[Math.floor(Math.random() * EMOJIS.length)];
  abrirPeer(ordemAleatoriaDeVagas(), 0);
}

// Tenta as vagas na ordem sorteada até achar uma livre.
function abrirPeer(ordem, indice) {
  if (indice >= ordem.length) {
    $('status').textContent = 'Sala cheia.';
    sistema('A sala está cheia (máximo de ' + MAX_SLOTS + ' pessoas).');
    return;
  }

  const slot = ordem[indice];
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
      abrirPeer(ordem, indice + 1); // vaga ocupada, tenta a próxima
    } else if (err.type === 'peer-unavailable') {
      // vaga vazia: normal. Só para de esperar resposta dela.
      pendentes.forEach((timer, idPendente) => {
        if (err.message && err.message.includes(idPendente)) {
          clearTimeout(timer);
          pendentes.delete(idPendente);
        }
      });
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

  // Se a vaga existe mas a conexão não abre, provavelmente a rede está bloqueando
  const timer = setTimeout(() => {
    pendentes.delete(idRemoto);
    if (!pares.has(idRemoto)) {
      sistema('Há alguém na sala, mas não consegui me conectar. A rede (celular, faculdade, empresa) ' +
        'pode estar bloqueando a conexão direta. Veja a seção sobre TURN no README.');
    }
  }, 15000);
  pendentes.set(idRemoto, timer);
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
    if (pendentes.has(id)) {
      clearTimeout(pendentes.get(id));
      pendentes.delete(id);
    }
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
      par = { id, nome: 'Alguém', emoji: '🙂', cor: corDoId(id), conn, saida: {}, naVoz: false, anunciado: false };
      pares.set(id, par);
      // Se estou transmitindo a tela, a nova pessoa recebe também.
      // O Voice chat é diferente: só chamo quem avisar que está nele.
      if (telaStream) chamar(par, 'screen');
    } else {
      par.conn = conn;
    }

    conn.send({ t: 'hello', nome: meuNome, emoji: meuEmoji, voz: !!micStream });
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
  fecharChamadaDeEntrada(id, 'voice');
  fecharChamadaDeEntrada(id, 'screen');

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
      par.emoji = d.emoji || '🙂';
      par.naVoz = !!d.voz;
      if (par.naVoz && micStream) chamar(par, 'voice'); // já estamos os dois no Voice chat
      if (!par.anunciado) {
        par.anunciado = true;
        sistema(par.nome + ' entrou na sala.');
      }
      atualizarPessoas();
      break;
    case 'msg':
      adicionarMensagem(par.nome, d.texto, false, par.cor, par.emoji);
      break;
    case 'voz-entrou':
      par.naVoz = true;
      // Se eu também estou no Voice chat, mando minha voz para quem acabou de entrar
      if (micStream) {
        fecharChamadaDeSaida(par, 'voice'); // garante uma chamada nova
        chamar(par, 'voice');
      }
      atualizarPessoas();
      break;
    case 'voz-parou':
      par.naVoz = false;
      fecharChamadaDeSaida(par, 'voice');   // essa pessoa não está mais ouvindo
      fecharChamadaDeEntrada(par.id, 'voice');
      atualizarPessoas();
      break;
    case 'tela-parou':
      fecharChamadaDeEntrada(par.id, 'screen');
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
  adicionarMensagem(meuNome, texto, true, corDoSlot(meuSlot), meuEmoji);
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

// Reescreve a linha "a=fmtp" do Opus no SDP com os parâmetros de qualidade.
// Quem manda o áudio usa o que o RECEPTOR pede, por isso aplicamos tanto ao
// iniciar a chamada quanto ao atendê-la.
function ajustarOpus(sdp, { stereo, bitrate }) {
  const rtpmap = sdp.match(/a=rtpmap:(\d+) opus\/48000\/2/i);
  if (!rtpmap) return sdp;
  const pt = rtpmap[1];
  const novos = {
    minptime: '10',
    useinbandfec: '1',   // correção de erros: aguenta perda de pacotes
    usedtx: '0',         // não corta o som nos momentos de silêncio
    cbr: '0',
    stereo: stereo ? '1' : '0',
    'sprop-stereo': stereo ? '1' : '0',
    maxaveragebitrate: String(bitrate),
    maxplaybackrate: '48000'
  };
  const montar = (atuais) => {
    const mapa = {};
    atuais.split(';').forEach((kv) => {
      const [k, v] = kv.trim().split('=');
      if (k) mapa[k] = v;
    });
    Object.assign(mapa, novos);
    return Object.keys(mapa).map((k) => k + '=' + mapa[k]).join(';');
  };
  const linhaFmtp = new RegExp('a=fmtp:' + pt + ' ([^\\r\\n]*)');
  if (linhaFmtp.test(sdp)) {
    return sdp.replace(linhaFmtp, (_, atuais) => 'a=fmtp:' + pt + ' ' + montar(atuais));
  }
  // Não havia linha fmtp: cria uma logo depois do rtpmap
  const linhaRtpmap = new RegExp('(a=rtpmap:' + pt + ' [^\\r\\n]*)');
  return sdp.replace(linhaRtpmap, (_, linha) => linha + '\r\na=fmtp:' + pt + ' ' + montar(''));
}

// Ajusta bitrate, fps e prioridade do vídeo enviado. O navegador só aceita
// isso depois que a negociação avança, então tentamos por alguns segundos.
async function aplicarQualidadeVideo(call, q) {
  for (let i = 0; i < 30; i++) {
    try {
      const pc = call.peerConnection;
      const sender = pc && pc.getSenders().find((s) => s.track && s.track.kind === 'video');
      if (sender) {
        const params = sender.getParameters();
        if (params.encodings && params.encodings.length) {
          params.encodings[0].maxBitrate = q.bitrate;
          params.encodings[0].maxFramerate = q.fps;
          params.encodings[0].scaleResolutionDownBy = 1;
          params.degradationPreference = q.prioridade;
          await sender.setParameters(params);
          return;
        }
      }
    } catch (e) { /* ainda negociando: tenta de novo */ }
    await esperar(500);
  }
}

function fecharChamadaDeSaida(par, tipo) {
  const call = par.saida[tipo];
  par.saida[tipo] = null;
  if (call) call.close();
}

function fecharChamadaDeEntrada(id, tipo) {
  const chave = id + '-' + tipo;
  const call = entradas.get(chave);
  entradas.delete(chave);
  if (call) call.close();
  removerMidia(id, tipo);
}

// Chamada de saída: eu mando minha voz ou minha tela para um par.
function chamar(par, tipo) {
  const stream = tipo === 'voice' ? micStream : telaStream;
  if (!stream || !peer || par.saida[tipo]) return;

  const call = peer.call(par.id, stream, {
    metadata: { tipo },
    sdpTransform: (sdp) => ajustarOpus(sdp, OPUS[tipo])
  });
  par.saida[tipo] = call;

  const limpar = () => { if (par.saida[tipo] === call) par.saida[tipo] = null; };
  call.on('close', limpar);
  call.on('error', limpar);

  if (tipo === 'screen') {
    const q = QUALIDADES_TELA[qualidadeTela];
    aplicarQualidadeVideo(call, q);
    // Reaplica quando a conexão fecha de fato, caso o navegador tenha zerado
    const pc = call.peerConnection;
    if (pc) {
      pc.addEventListener('connectionstatechange', () => {
        if (pc.connectionState === 'connected') aplicarQualidadeVideo(call, q);
      });
    }
  }
}

// Chamada de entrada: apenas recebo (não mando nada de volta nessa chamada).
function receberChamada(call) {
  const tipo = (call.metadata && call.metadata.tipo) || 'voice';
  const chave = call.peer + '-' + tipo;

  // Fora do Voice chat eu não ouço ninguém: recuso chamadas de voz.
  if (tipo === 'voice' && !micStream) {
    call.close();
    return;
  }

  const antiga = entradas.get(chave);
  if (antiga && antiga !== call) antiga.close();
  entradas.set(chave, call);

  call.answer(undefined, { sdpTransform: (sdp) => ajustarOpus(sdp, OPUS[tipo]) });
  call.on('stream', (stream) => mostrarMidia(call.peer, tipo, stream));
  call.on('close', () => {
    if (entradas.get(chave) === call) {
      entradas.delete(chave);
      removerMidia(call.peer, tipo);
    }
  });
  call.on('error', (e) => console.error('Erro na chamada', e));
}

function mostrarMidia(idPar, tipo, stream) {
  const chave = idPar + '-' + tipo;
  const par = pares.get(idPar);
  const nome = par ? par.nome : 'Alguém';

  if (tipo === 'voice') {
    if (!micStream) return; // fora do Voice chat: não toca a voz de ninguém
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
  v.muted = false;
  v.play().catch(() => {
    // Se o navegador bloquear o som, toca sem som e avisa
    v.muted = true;
    v.play().catch(() => {});
    sistema('O navegador bloqueou o som da transmissão. Clique no vídeo e ative o som.');
  });
  // Mostra se esta transmissão traz som
  const temSom = stream.getAudioTracks().length > 0;
  fig.querySelector('figcaption').textContent = 'Tela de ' + nome + (temSom ? ' 🔊' : ' 🔇 sem som');
  atualizarPalcoVazio();
}

function removerMidia(idPar, tipo) {
  const chave = idPar + '-' + tipo;
  document.querySelectorAll('[data-chave="' + chave + '"]').forEach((el) => el.remove());
  atualizarPalcoVazio();
}

/* ---- Voz ---- */

// Restrições do microfone. Com fones de ouvido o cancelamento de eco é
// desnecessário e deixa a voz com som mais "processado", então dá para desligar.
function restricoesMic() {
  return {
    echoCancellation: !$('chk-fones').checked,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
    sampleRate: 48000
  };
}

async function entrarNoVoiceChat() {
  if (micStream) return;
  $('btn-voz').disabled = true;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: restricoesMic() });
  } catch (e) {
    sistema('Não foi possível acessar o microfone (permissão negada ou sem dispositivo).');
    return;
  } finally {
    $('btn-voz').disabled = false;
  }
  // Mando minha voz só para quem já está no Voice chat. Quem entrar depois
  // avisa com "voz-entrou" e recebe a minha chamada nesse momento.
  pares.forEach((par) => { if (par.naVoz) chamar(par, 'voice'); });
  transmitir({ t: 'voz-entrou' });
  $('btn-voz').textContent = '📴 Sair do Voice chat';
  $('btn-voz').classList.add('ativo');
  $('btn-mudo').disabled = false;
  atualizarPessoas();
  sistema('Você entrou no Voice chat.');
}

function sairDoVoiceChat() {
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  micStream = null;
  // Paro de enviar minha voz e de ouvir os outros
  pares.forEach((par) => fecharChamadaDeSaida(par, 'voice'));
  [...entradas.keys()]
    .filter((chave) => chave.endsWith('-voice'))
    .forEach((chave) => fecharChamadaDeEntrada(chave.slice(0, -'-voice'.length), 'voice'));
  transmitir({ t: 'voz-parou' });
  $('btn-voz').textContent = '🎤 Entrar no Voice chat';
  $('btn-voz').classList.remove('ativo');
  $('btn-mudo').disabled = true;
  $('btn-mudo').textContent = 'Silenciar';
  atualizarPessoas();
  sistema('Você saiu do Voice chat.');
}

$('btn-voz').addEventListener('click', () => (micStream ? sairDoVoiceChat() : entrarNoVoiceChat()));

// "Estou de fones": aplica na hora, sem precisar sair do Voice chat
$('chk-fones').addEventListener('change', async () => {
  if (!micStream) return;
  try {
    await micStream.getAudioTracks()[0].applyConstraints(restricoesMic());
  } catch (e) {
    sistema('Não consegui trocar na hora. Saia e entre de novo no Voice chat para aplicar.');
  }
});

$('btn-mudo').addEventListener('click', () => {
  if (!micStream) return;
  const faixa = micStream.getAudioTracks()[0];
  faixa.enabled = !faixa.enabled;
  $('btn-mudo').textContent = faixa.enabled ? 'Silenciar' : 'Reativar microfone';
});

/* ---- Tela ---- */

async function compartilharTela() {
  qualidadeTela = $('sel-qualidade').value;
  const q = QUALIDADES_TELA[qualidadeTela];
  try {
    telaStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        width: { ideal: q.largura, max: q.largura },
        height: { ideal: q.altura, max: q.altura },
        frameRate: { ideal: q.fps, max: q.fps }
      },
      // Som da transmissão sem processamento de voz (senão música e jogos ficam abafados)
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      selfBrowserSurface: 'exclude', // não oferece esta própria aba para compartilhar
      systemAudio: 'include'         // já deixa marcada a opção de compartilhar o som
    });
  } catch (e) {
    sistema('Compartilhamento de tela cancelado ou não permitido.');
    return;
  }
  // Se a pessoa parar pelo botão do próprio navegador
  const faixaVideo = telaStream.getVideoTracks()[0];
  faixaVideo.addEventListener('ended', pararTela);
  // Dica para o codec: "motion" prioriza fluidez, "detail" prioriza nitidez (texto)
  if ('contentHint' in faixaVideo) faixaVideo.contentHint = q.dica;

  // O navegador só envia som se a pessoa marcar a opção no seletor de tela.
  const temSom = telaStream.getAudioTracks().length > 0;
  if (!temSom) {
    sistema('⚠️ Sua transmissão está SEM SOM. Para incluir o som, ao compartilhar escolha "Tela inteira" ' +
      'e ative "Compartilhar áudio do sistema" (Windows), ou escolha uma "Guia" e ative "Compartilhar áudio ' +
      'da guia". Janelas e o Firefox não enviam som; no Mac só funciona o som de uma guia do Chrome/Edge.');
  }

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
  legenda.textContent = 'Sua tela (prévia)' + (temSom ? ' 🔊 com som' : ' 🔇 sem som');
  fig.append(video, legenda);
  $('videos').appendChild(fig);
  atualizarPalcoVazio();

  $('btn-tela').textContent = '⏹️ Parar de compartilhar';
  $('btn-tela').classList.add('ativo');
  $('sel-qualidade').disabled = true; // a qualidade vale a partir do início da transmissão
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
  $('sel-qualidade').disabled = false;
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
