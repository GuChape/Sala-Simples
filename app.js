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

// Servidores STUN. Eles ajudam a descobrir o endereço de cada pessoa, mas NÃO
// resolvem redes que bloqueiam a conexão direta (celular em 4G/5G, alguns
// Wi-Fi, faculdade, empresa). Para esses casos é preciso um servidor TURN.
const CONFIG_PEER = {
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  }
};

// ---- TURN gratuito (Metered Open Relay, 20 GB/mês) ----
// 1. Crie uma conta em https://dashboard.metered.ca/signup?tool=turnserver
// 2. Preencha os dois campos abaixo (o README explica onde achar cada um).
// Deixe vazio para usar só a conexão direta.
const TURN_APP = '';      // nome do seu app, o "nome" de nome.metered.live
const TURN_API_KEY = '';  // sua API Key do Metered
let temTurn = false;

async function carregarServidoresIce() {
  if (!TURN_APP || !TURN_API_KEY) return;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const resp = await fetch(
      'https://' + TURN_APP + '.metered.live/api/v1/turn/credentials?apiKey=' + encodeURIComponent(TURN_API_KEY),
      { signal: ctrl.signal }
    );
    clearTimeout(timer);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const lista = await resp.json();
    if (Array.isArray(lista) && lista.length) {
      CONFIG_PEER.config.iceServers = CONFIG_PEER.config.iceServers.concat(lista);
      temTurn = true;
    }
  } catch (e) {
    console.error('TURN indisponível', e);
    sistema('Não consegui carregar o servidor TURN (confira o nome do app e a API Key no app.js). Usando só a conexão direta.');
  }
}

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
let telaStream = null;   // captura original (prévia local)
let telaEnvio = null;    // o que realmente é enviado: vídeo + áudio já sem a voz do Voice chat
let cameraStream = null; // câmera (só vídeo, sem áudio; a voz continua no Voice chat)
// 720p 30 fps; o seletor de qualidade entra na W3
// Qualidades da câmera (W3). Bitrate e fps valem por destinatário: cada câmera envia um vídeo para cada pessoa no Voice chat.
const QUALIDADES_CAMERA = {
  leve:   { largura: 640,  altura: 480,  fps: 15, bitrate: 400000,  prioridade: 'maintain-framerate' },
  padrao: { largura: 1280, altura: 720,  fps: 30, bitrate: 1200000, prioridade: 'balanced' },
  nitida: { largura: 1920, altura: 1080, fps: 30, bitrate: 2500000, prioridade: 'maintain-resolution' }
};
let qualidadeCamera = 'padrao';
let avisouBandaCamera = false;

function restricoesCamera(q) {
  return { width: { ideal: q.largura }, height: { ideal: q.altura }, frameRate: { ideal: q.fps, max: q.fps }, facingMode: 'user' };
}
let iniciandoTela = false;
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
  const lista = [{ nome: meuNome + ' (você)', emoji: meuEmoji, cor: corDoSlot(meuSlot), naVoz: !!micStream, camera: !!cameraStream }];
  pares.forEach((p) => lista.push(p));
  lista.forEach((p, i) => {
    if (i) el.append(', ');
    const s = document.createElement('span');
    // 🎙️ ao lado de quem está no Voice chat
    s.textContent = p.emoji + ' ' + p.nome + (p.naVoz ? ' 🎙️' : '') + (p.camera ? ' 📷' : '');
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

let entrando = false;

async function entrar() {
  if (entrando) return;
  meuNome = $('nome').value.trim() || 'Anônimo';
  sala = $('codigo').value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (!sala) {
    alert('Digite um código de sala (letras, números e hífen).');
    return;
  }
  entrando = true;
  location.hash = sala;
  $('entrada').hidden = true;
  $('app').hidden = false;
  $('sala-nome').textContent = sala;
  $('status').textContent = 'Conectando...';
  meuEmoji = EMOJIS[Math.floor(Math.random() * EMOJIS.length)];
  await carregarServidoresIce();
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
  let ouvintesOk = false;   // registra os ouvintes só uma vez, mesmo após reconectar
  let avisouEntrada = false;

  p.on('open', () => {
    peer = p;
    meuSlot = slot;
    $('status').textContent = 'Conectado' + (temTurn ? ' · TURN ativo' : ' · sem TURN');
    atualizarPessoas();
    if (!avisouEntrada) { avisouEntrada = true; sistema('Você entrou na sala.'); }

    if (!ouvintesOk) {
      ouvintesOk = true;
      p.on('connection', (conn) => registrarConexao(conn, false));
      p.on('call', receberChamada);
      p.on('disconnected', () => {
        $('status').textContent = 'Reconectando...';
        const tentar = () => {
          if (p.destroyed) return;
          if (p.disconnected) p.reconnect();
          else if ($('status').textContent === 'Reconectando...') $('status').textContent = 'Conectado' + (temTurn ? ' · TURN ativo' : ' · sem TURN');
          // se ainda não voltou, tenta de novo em 5 s
          if (p.disconnected) setTimeout(tentar, 5000);
        };
        setTimeout(tentar, 1000);
      });
    }

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
      sistema('Há alguém na sala, mas não consegui me conectar. ' + (temTurn
        ? 'Mesmo com o servidor TURN a conexão falhou. Confira o nome do app e a API Key no app.js.'
        : 'Provavelmente a rede (celular 4G/5G, certos Wi-Fi, faculdade, empresa) impede a conexão direta. ' +
          'A solução é configurar um servidor TURN (veja o README).'));
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

    conn.send({ t: 'hello', nome: meuNome, emoji: meuEmoji, voz: !!micStream, cam: !!cameraStream });
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
  fecharChamadaDeEntrada(id, 'camera');

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
      par.camera = !!d.cam;
      if (par.naVoz && micStream) chamar(par, 'voice'); // já estamos os dois no Voice chat
      if (par.naVoz && cameraStream) chamar(par, 'camera');
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
      // Quem entrou no Voice chat agora também recebe minha câmera, se estiver ligada
      if (cameraStream) {
        fecharChamadaDeSaida(par, 'camera');
        chamar(par, 'camera');
      }
      atualizarPessoas();
      break;
    case 'voz-parou':
      par.naVoz = false;
      fecharChamadaDeSaida(par, 'voice');   // essa pessoa não está mais ouvindo
      fecharChamadaDeSaida(par, 'camera');  // câmera só vai para quem está no Voice chat
      fecharChamadaDeEntrada(par.id, 'voice');
      atualizarPessoas();
      break;
    case 'tela-parou':
      fecharChamadaDeEntrada(par.id, 'screen');
      break;
    case 'cam-ligou':
      par.camera = true;
      atualizarPessoas();
      break;
    case 'cam-parou':
      par.camera = false;
      fecharChamadaDeEntrada(par.id, 'camera');
      atualizarPessoas();
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

/* ---- Pré-visualização de imagens, vídeos e áudios no chat ---- */

// Usado quando o tipo do arquivo vem vazio (acontece com alguns formatos).
const MIME_POR_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg',
  mov: 'video/quicktime', mkv: 'video/x-matroska',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg',
  m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac'
};

function mimeEfetivo(nome, mime) {
  if (mime && mime !== 'application/octet-stream') return mime.toLowerCase();
  const ext = (nome.split('.').pop() || '').toLowerCase();
  return MIME_POR_EXT[ext] || '';
}

// Cria a pré-visualização (ou devolve null se o arquivo não for imagem, vídeo ou áudio).
// "fonte" é um File ou Blob.
function criarPreview(fonte, nome, mime) {
  const m = mimeEfetivo(nome, mime);
  const tipo = m.startsWith('image/') ? 'imagem' : m.startsWith('video/') ? 'video' : m.startsWith('audio/') ? 'audio' : null;
  if (!tipo) return null;

  const blob = fonte.type === m ? fonte : new Blob([fonte], { type: m });
  const url = URL.createObjectURL(blob);
  const caixa = document.createElement('div');
  caixa.className = 'preview';

  const ext = (nome.split('.').pop() || '').toUpperCase();
  const falhou = () => {
    caixa.className = 'preview erro';
    const verbo = tipo === 'imagem' ? 'exibir' : 'tocar';
    caixa.textContent = 'Este navegador não consegue ' + verbo + ' ' + ext + ' aqui. Use o link para baixar; MP4 (H.264) toca na maioria dos navegadores.';
  };

  if (tipo === 'imagem') {
    const img = document.createElement('img');
    img.src = url;
    img.alt = nome;
    img.title = 'Clique para ampliar';
    img.addEventListener('load', rolarChat);
    img.addEventListener('error', falhou);
    img.addEventListener('click', () => abrirLightbox(url, nome));
    caixa.appendChild(img);
  } else {
    // Vídeo e áudio usam os controles do navegador: play, volume, mudo, tela cheia
    const midia = document.createElement(tipo === 'video' ? 'video' : 'audio');
    midia.src = url;
    midia.controls = true;
    midia.preload = 'metadata';
    if (tipo === 'video') midia.playsInline = true;
    midia.addEventListener('loadedmetadata', rolarChat);
    midia.addEventListener('error', falhou);
    // Ao dar play em um, pausa os outros
    midia.addEventListener('play', () => {
      document.querySelectorAll('.preview video, .preview audio').forEach((o) => { if (o !== midia) o.pause(); });
    });
    caixa.appendChild(midia);
  }
  return caixa;
}

// Imagem em tela cheia: clique na imagem para dar zoom (e de novo para voltar),
// arraste para mover quando ampliada, e feche com ✕, Esc ou clicando fora.
function abrirLightbox(url, nome) {
  const fundo = document.createElement('div');
  fundo.className = 'lightbox';
  const img = document.createElement('img');
  img.src = url;
  img.alt = nome;
  img.draggable = false;
  const fechar = document.createElement('button');
  fechar.className = 'lightbox-fechar';
  fechar.textContent = '✕';
  fechar.title = 'Fechar (Esc)';
  const legenda = document.createElement('div');
  legenda.className = 'lightbox-legenda';
  legenda.textContent = nome;
  fundo.append(img, fechar, legenda);

  const aoTeclar = (e) => { if (e.key === 'Escape') fecharTudo(); };
  function fecharTudo() {
    document.removeEventListener('keydown', aoTeclar);
    fundo.remove();
  }
  document.addEventListener('keydown', aoTeclar);
  fechar.addEventListener('click', fecharTudo);
  fundo.addEventListener('click', (e) => { if (e.target === fundo) fecharTudo(); });

  let ampliada = false;
  let arrastou = false;   // true se o último gesto foi um arrasto (não conta como clique)
  let arrasto = null;

  img.addEventListener('click', (e) => {
    if (arrastou) { arrastou = false; return; }
    ampliada = !ampliada;
    if (ampliada) {
      // Zoom de 2,5x em direção ao ponto clicado
      const r = img.getBoundingClientRect();
      const fx = (e.clientX - r.left) / r.width;
      const fy = (e.clientY - r.top) / r.height;
      img.style.maxWidth = 'none';
      img.style.maxHeight = 'none';
      img.style.width = r.width * 2.5 + 'px';
      img.style.height = 'auto';
      img.classList.add('ampliada');
      fundo.scrollLeft = fx * img.offsetWidth - fundo.clientWidth / 2;
      fundo.scrollTop = fy * img.offsetHeight - fundo.clientHeight / 2;
    } else {
      img.removeAttribute('style');
      img.classList.remove('ampliada');
    }
  });

  // Arrastar para mover a imagem ampliada
  img.addEventListener('pointerdown', (e) => {
    arrastou = false;
    if (!ampliada) return;
    arrasto = { x: e.clientX, y: e.clientY, sl: fundo.scrollLeft, st: fundo.scrollTop, moveu: false };
    img.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  img.addEventListener('pointermove', (e) => {
    if (!arrasto) return;
    const dx = e.clientX - arrasto.x;
    const dy = e.clientY - arrasto.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) arrasto.moveu = true;
    fundo.scrollLeft = arrasto.sl - dx;
    fundo.scrollTop = arrasto.st - dy;
  });
  const soltar = () => {
    if (arrasto) { arrastou = arrasto.moveu; arrasto = null; }
  };
  img.addEventListener('pointerup', soltar);
  img.addEventListener('pointercancel', soltar);

  document.body.appendChild(fundo);
}

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
  // Quem envia também vê a imagem/vídeo no chat, logo de início
  const previaPropria = criarPreview(arquivo, arquivo.name, arquivo.type);
  if (previaPropria) ui.el.insertBefore(previaPropria, ui.t);
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
  // O receptor guarda o arquivo inteiro na memória. Celulares têm bem menos memória por aba.
  const celular = /iPhone|iPad|Android/i.test(navigator.userAgent);
  const limite = celular ? 400 * 1024 * 1024 : 2 * 1024 * 1024 * 1024;
  if (d.tamanho > limite) ui.t.textContent += ' · pode falhar neste aparelho (memória insuficiente)';
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

  // Imagem, vídeo ou áudio: mostra no chat, com o link de download logo abaixo
  const previa = criarPreview(blob, r.nome, r.tipo);
  if (previa) r.el.insertBefore(previa, link);
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
let avisouQualidade = false;
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
          try {
            await sender.setParameters(params);
          } catch (e) {
            // Alguns navegadores recusam a prioridade de degradação: aplica sem ela
            delete params.degradationPreference;
            await sender.setParameters(params);
            console.warn('Navegador não aceitou a prioridade de qualidade; bitrate e fps limitados.');
            if (!avisouQualidade) {
              avisouQualidade = true;
              sistema('Seu navegador não aceitou a prioridade de qualidade. A transmissão segue com bitrate e fps limitados.');
            }
          }
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
  const stream = tipo === 'voice' ? micStream : tipo === 'camera' ? cameraStream : (telaEnvio || telaStream);
  if (!stream || !peer || par.saida[tipo]) return;

  const call = peer.call(par.id, stream, {
    metadata: { tipo },
    sdpTransform: (sdp) => ajustarOpus(sdp, OPUS[tipo])
  });
  par.saida[tipo] = call;

  const limpar = () => { if (par.saida[tipo] === call) par.saida[tipo] = null; };
  call.on('close', limpar);
  call.on('error', limpar);

  if (tipo === 'camera') {
    aplicarQualidadeVideo(call, QUALIDADES_CAMERA[qualidadeCamera]);
    const destinatarios = [...pares.values()].filter((p) => p.naVoz).length;
    if (destinatarios >= 3 && !avisouBandaCamera) {
      avisouBandaCamera = true;
      sistema('Sua câmera está indo para ' + destinatarios + ' pessoas. Cada uma recebe um vídeo separado; se a conexão travar, escolha 480p ou desligue a câmera.');
    }
  }

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
  // Câmera: só vejo quem está no Voice chat comigo
  if (tipo === 'camera' && !micStream) {
    call.close();
    return;
  }

  const antiga = entradas.get(chave);
  if (antiga && antiga !== call) antiga.close();
  entradas.set(chave, call);

  if (tipo === 'camera') call.answer();
  else call.answer(undefined, { sdpTransform: (sdp) => ajustarOpus(sdp, OPUS[tipo]) });
  call.on('stream', (stream) => mostrarMidia(call.peer, tipo, stream));
  call.on('close', () => {
    if (entradas.get(chave) === call) {
      entradas.delete(chave);
      removerMidia(call.peer, tipo);
    }
  });
  call.on('error', (e) => console.error('Erro na chamada', e));
}

// Quando o navegador bloqueia o som de uma voz, oferece um botão no chat para liberar
function mostrarAtivarSom(audio, nome) {
  if (audio.dataset.avisou) return;
  audio.dataset.avisou = '1';
  const d = document.createElement('div');
  d.className = 'msg sistema';
  const b = document.createElement('button');
  b.textContent = '🔊 Ativar som da voz de ' + nome;
  b.addEventListener('click', () => { audio.play().catch(() => {}); d.remove(); });
  d.appendChild(b);
  $('mensagens').appendChild(d);
  rolarChat();
}

// Tela cheia: no computador usa o quadro inteiro; no iPhone usa o vídeo nativo
function telaCheia(fig) {
  if (!fig) return;
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    return;
  }
  const pedir = fig.requestFullscreen || fig.webkitRequestFullscreen;
  if (pedir) {
    try { const p = pedir.call(fig); if (p && p.catch) p.catch(() => abrirVideoNativo(fig)); }
    catch (e) { abrirVideoNativo(fig); }
  } else {
    abrirVideoNativo(fig);
  }
}

function abrirVideoNativo(fig) {
  const v = fig.querySelector('video');
  if (v && v.webkitEnterFullscreen) v.webkitEnterFullscreen();
  else sistema('Este navegador não permite tela cheia aqui.');
}

// Um clique no botão ⛶ ou na câmera amplia o quadro
$('videos').addEventListener('click', (e) => {
  const botao = e.target.closest && e.target.closest('.ampliar');
  if (botao) { telaCheia(botao.closest('figure')); return; }
  if (e.target.tagName === 'VIDEO' && !e.target.controls) telaCheia(e.target.closest('figure'));
});

function mostrarMidia(idPar, tipo, stream) {
  const chave = idPar + '-' + tipo;
  const par = pares.get(idPar);
  const nome = idPar === 'eu' ? 'você' : par ? par.nome : 'Alguém';

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
    audio.play().catch(() => mostrarAtivarSom(audio, nome));
    // Se estou transmitindo a tela, esta voz serve de referência para tirá-la do som da transmissão
    adicionarReferenciaEco(chave, stream);
    return;
  }

  // tela ou câmera (câmera não tem áudio e não usa o controle de som)
  const camera = tipo === 'camera';
  let fig = document.querySelector('figure[data-chave="' + chave + '"]');
  if (!fig) {
    fig = document.createElement('figure');
    fig.dataset.chave = chave;
    if (camera && idPar === 'eu') fig.classList.add('espelho');
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.controls = !camera;
    video.muted = true;
    const legenda = document.createElement('figcaption');
    legenda.textContent = idPar === 'eu' ? 'Sua câmera (prévia)' : camera ? 'Câmera de ' + nome : 'Tela de ' + nome;
    const ampliar = document.createElement('button');
    ampliar.className = 'ampliar sec';
    ampliar.textContent = '⛶';
    ampliar.title = 'Tela cheia';
    fig.append(video, legenda, ampliar);
    $('videos').appendChild(fig);
  }
  const v = fig.querySelector('video');
  v.srcObject = stream;
  if (camera) {
    v.play().catch(() => {});
    atualizarPalcoVazio();
    return;
  }
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
  if (tipo === 'voice') removerReferenciaEco(chave);
  document.querySelectorAll('[data-chave="' + chave + '"]').forEach((el) => el.remove());
  atualizarPalcoVazio();
}

/* ---------------------------- Câmera ---------------------------- */

// Traduz o erro do navegador em uma instrução que a pessoa consegue seguir
function explicarErroCamera(e) {
  const nome = e && e.name;
  if (nome === 'NotAllowedError' || nome === 'SecurityError') {
    return 'Permissão da câmera negada. Libere a câmera no cadeado ao lado do endereço do site e clique de novo.';
  }
  if (nome === 'NotFoundError' || nome === 'DevicesNotFoundError') {
    return 'Nenhuma câmera encontrada neste aparelho.';
  }
  if (nome === 'NotReadableError' || nome === 'TrackStartError') {
    return 'A câmera está sendo usada por outro programa ou aba. Feche-o e tente de novo.';
  }
  return 'Não foi possível acessar a câmera.';
}

function podeCamera() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

// Pede a câmera com a qualidade escolhida; se o aparelho não aceitar, tenta com restrições mais simples
async function capturarCamera(q) {
  const tentativas = [restricoesCamera(q), { facingMode: 'user' }, true];
  let erro = null;
  for (const video of tentativas) {
    try {
      return await navigator.mediaDevices.getUserMedia({ video, audio: false });
    } catch (e) {
      erro = e;
      if (e.name !== 'OverconstrainedError') break;
    }
  }
  throw erro;
}

async function ligarCamera() {
  if (cameraStream) return;
  if (!podeCamera()) {
    sistema('Seu navegador não permite câmera aqui. Abra o site em HTTPS (como o endereço do GitHub Pages) e use um navegador atualizado.');
    return;
  }
  $('btn-camera').disabled = true;
  try {
    cameraStream = await capturarCamera(QUALIDADES_CAMERA[qualidadeCamera]);
  } catch (e) {
    sistema(explicarErroCamera(e));
    return;
  } finally {
    $('btn-camera').disabled = false;
  }
  // Se o aparelho desconectar a câmera, desliga sozinho
  cameraStream.getVideoTracks()[0].addEventListener('ended', pararCamera);
  // Minha câmera vai só para quem está no Voice chat
  pares.forEach((par) => { if (par.naVoz) chamar(par, 'camera'); });
  transmitir({ t: 'cam-ligou' });
  mostrarMidia('eu', 'camera', cameraStream);
  $('btn-camera').textContent = '📷 Desligar câmera';
  $('btn-camera').classList.add('ativo');
  atualizarBotaoTrocar();
  atualizarPessoas();
}

// O botão de trocar câmera aparece no celular ou quando há mais de uma câmera
async function atualizarBotaoTrocar() {
  let mais = false;
  try {
    const coarse = window.matchMedia && matchMedia('(pointer: coarse)').matches;
    const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    mais = coarse || cams.length > 1;
  } catch (e) { mais = false; }
  $('btn-trocar-cam').hidden = !cameraStream || !mais;
}

let facingAtual = 'user';

// Troca de câmera: no computador com várias câmeras cicla o dispositivo; no celular alterna frontal/traseira.
// A nova faixa entra no lugar da antiga em cada conexão, sem refazer a chamada.
async function trocarCamera() {
  if (!cameraStream) return;
  const q = QUALIDADES_CAMERA[qualidadeCamera];
  const antiga = cameraStream;
  let novo = null;
  try {
    const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    const atual = antiga.getVideoTracks()[0].getSettings().deviceId;
    if (cams.length > 1) {
      const i = cams.findIndex((d) => d.deviceId === atual);
      const prox = cams[(i + 1) % cams.length];
      novo = await navigator.mediaDevices.getUserMedia({ video: { ...restricoesCamera(q), deviceId: { exact: prox.deviceId } }, audio: false });
    } else {
      facingAtual = facingAtual === 'user' ? 'environment' : 'user';
      novo = await navigator.mediaDevices.getUserMedia({ video: { ...restricoesCamera(q), facingMode: { ideal: facingAtual } }, audio: false });
    }
  } catch (e) {
    sistema('Não foi possível trocar de câmera. ' + explicarErroCamera(e));
    return;
  }

  const faixa = novo.getVideoTracks()[0];
  faixa.addEventListener('ended', pararCamera);
  cameraStream = novo;
  antiga.getTracks().forEach((t) => t.stop()); // libera a câmera antiga

  // Troca a faixa em cada envio; se a conexão ainda não tem o envio, refaz a chamada
  pares.forEach((par) => {
    if (!par.naVoz) return;
    const call = par.saida.camera;
    const pc = call && call.peerConnection;
    const sender = pc && pc.getSenders().find((s) => s.track && s.track.kind === 'video');
    if (sender) sender.replaceTrack(faixa).catch(() => fecharChamadaDeSaida(par, 'camera'));
    else { fecharChamadaDeSaida(par, 'camera'); chamar(par, 'camera'); }
  });

  // Atualiza a prévia; espelho só na câmera frontal
  removerMidia('eu', 'camera');
  mostrarMidia('eu', 'camera', novo);
  const fig = document.querySelector('figure[data-chave="eu-camera"]');
  if (fig && navigator.mediaDevices) fig.classList.toggle('espelho', facingAtual === 'user');
}

function pararCamera() {
  if (!cameraStream) return;
  cameraStream.getTracks().forEach((t) => t.stop());
  cameraStream = null;
  $('btn-trocar-cam').hidden = true;
  pares.forEach((par) => fecharChamadaDeSaida(par, 'camera'));
  transmitir({ t: 'cam-parou' });
  removerMidia('eu', 'camera');
  $('btn-camera').textContent = '📷 Ligar câmera';
  $('btn-camera').classList.remove('ativo');
  atualizarPessoas();
}

$('btn-camera').addEventListener('click', () => (cameraStream ? pararCamera() : ligarCamera()));

// Trocar a qualidade com a câmera ligada: ajusta a captura e o envio de cada destinatário
$('sel-qualidade-cam').addEventListener('change', async (e) => {
  qualidadeCamera = e.target.value;
  const q = QUALIDADES_CAMERA[qualidadeCamera];
  if (!cameraStream) return;
  const faixa = cameraStream.getVideoTracks()[0];
  try {
    await faixa.applyConstraints({ width: { ideal: q.largura }, height: { ideal: q.altura }, frameRate: { ideal: q.fps, max: q.fps } });
  } catch (err) {
    console.warn('Não foi possível mudar a captura da câmera; o envio foi limitado mesmo assim.', err);
  }
  pares.forEach((par) => { if (par.saida.camera) aplicarQualidadeVideo(par.saida.camera, q); });
});

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
  pares.forEach((par) => { if (par.naVoz) { chamar(par, 'voice'); chamar(par, 'camera'); } });
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
  // Sem Voice chat eu não vejo câmeras
  [...entradas.keys()]
    .filter((chave) => chave.endsWith('-camera'))
    .forEach((chave) => fecharChamadaDeEntrada(chave.slice(0, -'-camera'.length), 'camera'));
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
    await micStream.getAudioTracks()[0].applyConstraints({ echoCancellation: !$('chk-fones').checked });
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

/* ---- Cancelamento de eco da transmissão ---- */

// Ao compartilhar a tela com som, o navegador captura TUDO o que toca no computador,
// inclusive a voz das outras pessoas do Voice chat. Sem tratamento, quem falou se ouve
// de volta na transmissão. Aqui a transmissão passa por um filtro (cancelador-eco.js)
// que recebe como referência as mesmas vozes que estou tocando e as subtrai do som
// capturado. Funciona em qualquer navegador, com tela inteira ou janela.
let eco = null; // { ctx, no, fonte, barramento, destino, fontes: Map(chave -> nó) }

// Precisa ser chamada direto no clique (política de autoplay) e devolve o contexto pronto, ou null.
async function prepararEco() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx || !window.AudioWorkletNode) return null;
  let ctx;
  try {
    ctx = new Ctx({ sampleRate: 48000, latencyHint: 'interactive' });
  } catch (e) {
    try { ctx = new Ctx(); } catch (e2) { return null; }
  }
  ctx.resume().catch(() => {});
  try {
    await ctx.audioWorklet.addModule('cancelador-eco.js');
  } catch (e) {
    console.error('Não consegui carregar o cancelador de eco', e);
    ctx.close().catch(() => {});
    return null;
  }
  return ctx;
}

// Liga o áudio capturado ao filtro e devolve a faixa de áudio limpa.
async function montarEco(ctx, faixaAudio) {
  const no = new AudioWorkletNode(ctx, 'cancelador-eco', {
    numberOfInputs: 2,            // 0 = som capturado da tela, 1 = vozes que estou tocando
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers'
  });
  const fonte = ctx.createMediaStreamSource(new MediaStream([faixaAudio]));
  const barramento = ctx.createGain();   // soma de todas as vozes que estou tocando
  const destino = ctx.createMediaStreamDestination();
  const analisador = ctx.createAnalyser(); // só para o alarme de referência silenciosa
  fonte.connect(no, 0, 0);
  barramento.connect(no, 0, 1);
  barramento.connect(analisador);
  no.connect(destino);
  eco = { ctx, no, fonte, barramento, destino, fontes: new Map(), analisador, silencio: 0, avisou: false, timer: null };
  eco.timer = setInterval(verificarReferencia, 2000);

  // vozes que já estão tocando neste momento
  document.querySelectorAll('#audios audio').forEach((a) => {
    if (a.srcObject) adicionarReferenciaEco(a.dataset.chave, a.srcObject);
  });

  // Se o navegador deixar o contexto suspenso, a transmissão ficaria muda: então desiste
  await Promise.race([ctx.resume(), esperar(1500)]);
  if (ctx.state !== 'running') throw new Error('contexto de áudio não iniciou');
  return destino.stream.getAudioTracks()[0];
}

function adicionarReferenciaEco(chave, stream) {
  if (!eco || !stream || !stream.getAudioTracks().length) return;
  removerReferenciaEco(chave);
  try {
    const fonte = eco.ctx.createMediaStreamSource(stream);
    fonte.connect(eco.barramento);
    eco.fontes.set(chave, fonte);
  } catch (e) {
    console.error('Referência de eco indisponível', e);
  }
}

function removerReferenciaEco(chave) {
  if (!eco) return;
  const fonte = eco.fontes.get(chave);
  if (!fonte) return;
  try { fonte.disconnect(); } catch (e) { /* já desconectada */ }
  eco.fontes.delete(chave);
}

// Alarme: se as vozes do Voice chat tocam mas o filtro não recebe nada, o eco volta sem aviso.
function verificarReferencia() {
  if (!eco || !eco.analisador) return;
  const tocando = [...document.querySelectorAll('#audios audio')].some((a) => a.srcObject && !a.paused);
  if (!tocando) { eco.silencio = 0; return; }
  const buf = new Float32Array(eco.analisador.fftSize);
  eco.analisador.getFloatTimeDomainData(buf);
  let soma = 0;
  for (let i = 0; i < buf.length; i++) soma += buf[i] * buf[i];
  const nivel = Math.sqrt(soma / buf.length);
  eco.silencio = nivel < 1e-4 ? eco.silencio + 1 : 0;
  // 15 checagens de 2 s = 30 s sem nenhum som. Antes disso não dá para separar silêncio de defeito.
  if (eco.silencio >= 15 && !eco.avisou) {
    eco.avisou = true;
    sistema('⚠️ O filtro não está recebendo a voz das outras pessoas (30 s sem som do Voice chat). ' +
      'Se quem assiste ouvir a própria voz, compartilhe uma guia em vez da tela inteira.');
  }
}

function fecharEco() {
  if (!eco) return;
  clearInterval(eco.timer);
  const ctx = eco.ctx;
  eco = null;
  ctx.close().catch(() => {});
}

/* ---- Tela ---- */

function podeCompartilharTela() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
}

async function compartilharTela() {
  if (iniciandoTela || telaStream) return;
  if (!podeCompartilharTela()) {
    sistema('Seu navegador não permite compartilhar a tela (comum em iPhone e iPad). Use um computador para transmitir.');
    return;
  }
  iniciandoTela = true;
  qualidadeTela = $('sel-qualidade').value;
  const q = QUALIDADES_TELA[qualidadeTela];

  // O contexto de áudio do cancelador precisa nascer no clique; o resto carrega em paralelo
  const preparoEco = prepararEco();

  try {
    let captura;
    try {
      captura = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { ideal: q.largura, max: q.largura },
          height: { ideal: q.altura, max: q.altura },
          frameRate: { ideal: q.fps, max: q.fps }
        },
        // Som da transmissão sem processamento de voz (senão música e jogos ficam abafados)
        audio: {
          echoCancellation: false, noiseSuppression: false, autoGainControl: false,
          // Chrome/Edge 140+ (Windows e Mac): já deixa de capturar o som desta página.
          // Não dependemos disso: o cancelador abaixo cobre os demais casos.
          restrictOwnAudio: true
        },
        selfBrowserSurface: 'exclude', // não oferece esta própria aba para compartilhar
        systemAudio: 'include'         // já deixa marcada a opção de compartilhar o som
      });
    } catch (e) {
      sistema('Compartilhamento de tela cancelado ou não permitido.');
      const ctx = await preparoEco;
      if (ctx) ctx.close().catch(() => {});
      return;
    }

    const faixaVideo = captura.getVideoTracks()[0];
    const faixaAudio = captura.getAudioTracks()[0];
    const temSom = !!faixaAudio;
    const ctxEco = await preparoEco;

    // Som da transmissão: passa pelo cancelador para tirar a voz do Voice chat
    let envio = captura;
    if (faixaAudio && ctxEco) {
      try {
        const faixaLimpa = await montarEco(ctxEco, faixaAudio);
        envio = new MediaStream([faixaVideo, faixaLimpa]);
      } catch (e) {
        console.error('Cancelador de eco falhou', e);
        fecharEco();
        ctxEco.close().catch(() => {});
        sistema('⚠️ Não consegui ativar o filtro que tira a voz do Voice chat do som da transmissão. ' +
          'Se quem assiste se ouvir de volta, compartilhe uma guia em vez da tela inteira.');
      }
    } else if (ctxEco) {
      ctxEco.close().catch(() => {});
    } else if (faixaAudio) {
      sistema('⚠️ Este navegador não permite filtrar a voz do Voice chat do som da transmissão. ' +
        'Se quem assiste se ouvir de volta, compartilhe uma guia em vez da tela inteira.');
    }

    telaStream = captura;
    telaEnvio = envio;

    // Se a pessoa parar pelo botão do próprio navegador
    faixaVideo.addEventListener('ended', pararTela);
    if (faixaVideo.readyState === 'ended') { pararTela(); return; }
    // Dica para o codec: "motion" prioriza fluidez, "detail" prioriza nitidez (texto)
    if ('contentHint' in faixaVideo) faixaVideo.contentHint = q.dica;

    // O navegador só envia som se a pessoa marcar a opção no seletor de tela.
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
    const ampliar = document.createElement('button');
    ampliar.className = 'ampliar sec';
    ampliar.textContent = '⛶';
    ampliar.title = 'Tela cheia';
    fig.append(video, legenda, ampliar);
    $('videos').appendChild(fig);
    atualizarPalcoVazio();

    $('btn-tela').textContent = '⏹️ Parar de compartilhar';
    $('btn-tela').classList.add('ativo');
    $('sel-qualidade').disabled = true; // a qualidade vale a partir do início da transmissão
  } finally {
    iniciandoTela = false;
  }
}

function pararTela() {
  if (!telaStream) return;
  telaStream.getTracks().forEach((t) => t.stop());
  if (telaEnvio) telaEnvio.getTracks().forEach((t) => t.stop());
  telaStream = null;
  telaEnvio = null;
  fecharEco();
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
if (!podeCompartilharTela()) {
  $('btn-tela').hidden = true;
  $('sel-qualidade').hidden = true;
}

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
  try { $('codigo').value = decodeURIComponent(location.hash.slice(1)); } catch (e) { /* hash malformado: ignora */ }
}

// Libera a vaga ao sair. pagehide funciona melhor que beforeunload no Safari e no celular.
window.addEventListener('pagehide', () => {
  // Solta a câmera e o microfone (a luz do aparelho apaga)
  if (cameraStream) cameraStream.getTracks().forEach((t) => t.stop());
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  if (peer && !peer.destroyed) { try { peer.destroy(); } catch (e) { /* já encerrado */ } }
});

$('btn-trocar-cam').addEventListener('click', trocarCamera);
if (!podeCamera()) $('btn-camera').hidden = true; // navegador sem câmera: esconde o botão
