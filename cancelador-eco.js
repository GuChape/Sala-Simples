// Cancelador de eco para a transmissão de tela (AudioWorklet).
//
// Problema: ao compartilhar a tela com o "áudio do sistema", o navegador captura TUDO
// que sai nas caixas de som, inclusive a voz das outras pessoas do Voice chat. Essa voz
// volta pela transmissão e quem falou se ouve de volta, com atraso.
//
// Solução: quem transmite tem uma cópia digital exata das vozes que está tocando
// (entrada 1, "referência"). Este filtro aprende o caminho caixa de som -> captura
// (atraso + volume) e subtrai a voz do áudio capturado (entrada 0), deixando só o
// som de verdade da tela (saída).
//
// Algoritmo: filtro adaptativo particionado no domínio da frequência (PBFDAF / MDF),
// com blocos de 128 amostras (o tamanho do bloco do Web Audio) e 96 partições,
// ou seja, cobre atrasos de até ~256 ms.

const BLOCO = 128;            // amostras por bloco (igual ao quantum do Web Audio)
const TAM_FFT = BLOCO * 2;
const BINS = BLOCO + 1;
const PARTICOES = 96;         // 96 x 128 amostras ~ 256 ms a 48 kHz
const MU = 0.02;              // passo de adaptação (menor = mais limpo, mais lento para aprender)
const ALFA = 0.2;             // 0 = passo todo nas partições com eco; 1 = passo igual em todas
const REGULARIZACAO = 2e-3;   // evita dividir por ~0 quando a referência é silêncio
const LIMIAR_REF = 1e-7;      // energia média mínima da referência para adaptar (~ -70 dBFS)

class CanceladorEco extends AudioWorkletProcessor {
  constructor() {
    super();
    this.xbuf = new Float64Array(TAM_FFT);          // últimas 2 blocos de referência
    this.Xre = new Float64Array(PARTICOES * BINS);  // espectros dos últimos blocos de referência
    this.Xim = new Float64Array(PARTICOES * BINS);
    this.Wre = new Float64Array(PARTICOES * BINS);  // pesos do filtro (por partição)
    this.Wim = new Float64Array(PARTICOES * BINS);
    this.cabeca = 0;      // partição 0 = bloco mais recente
    this.projecao = 0;    // qual partição é "limpa" neste bloco (rodízio)
    this.enEntrada = 0;   // energia suavizada do áudio da tela (entrada)
    this.enSaida = 0;     // energia suavizada da saída (para detectar piora)

    this.yRe = new Float64Array(TAM_FFT);
    this.yIm = new Float64Array(TAM_FFT);
    this.eRe = new Float64Array(TAM_FFT);
    this.eIm = new Float64Array(TAM_FFT);
    this.pot = new Float64Array(BINS);
    this.ganho = new Float64Array(PARTICOES);   // passo relativo de cada partição
    this.d = new Float64Array(BLOCO);
    this.est = new Float64Array(BLOCO);

    // tabelas da FFT
    this.rev = new Uint16Array(TAM_FFT);
    this.cos = new Float64Array(TAM_FFT / 2);
    this.sin = new Float64Array(TAM_FFT / 2);
    const bits = Math.log2(TAM_FFT);
    for (let i = 0; i < TAM_FFT; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
      this.rev[i] = r;
    }
    for (let k = 0; k < TAM_FFT / 2; k++) {
      this.cos[k] = Math.cos((2 * Math.PI * k) / TAM_FFT);
      this.sin[k] = Math.sin((2 * Math.PI * k) / TAM_FFT);
    }
  }

  // FFT in-place (radix-2). inverso = true já divide por N.
  fft(re, im, inverso) {
    const n = TAM_FFT, rev = this.rev, cs = this.cos, sn = this.sin;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let tam = 2; tam <= n; tam <<= 1) {
      const meio = tam >> 1, passo = n / tam;
      for (let i = 0; i < n; i += tam) {
        for (let j = 0, k = 0; j < meio; j++, k += passo) {
          const wr = cs[k], wi = inverso ? sn[k] : -sn[k];
          const a = i + j, b = a + meio;
          const tr = re[b] * wr - im[b] * wi;
          const ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
    if (inverso) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }

  // Completa o espectro de um sinal real (bins 0..BLOCO) com a metade espelhada
  espelhar(re, im) {
    for (let k = 1; k < BLOCO; k++) {
      re[TAM_FFT - k] = re[k];
      im[TAM_FFT - k] = -im[k];
    }
  }

  process(inputs, outputs) {
    const saida = outputs[0];
    if (!saida || !saida.length) return true;
    const entrada = inputs[0];
    const ref = inputs[1];
    const nCanais = entrada ? entrada.length : 0;

    // Sem áudio de tela chegando: silêncio
    if (!nCanais) {
      for (let c = 0; c < saida.length; c++) saida[c].fill(0);
      return true;
    }
    // Tamanho de bloco diferente do esperado: só repassa o áudio
    if (entrada[0].length !== BLOCO) {
      for (let c = 0; c < saida.length; c++) saida[c].set(entrada[Math.min(c, nCanais - 1)]);
      return true;
    }

    const d = this.d, xbuf = this.xbuf;

    // áudio da tela em mono (para o filtro aprender) e referência em mono
    for (let i = 0; i < BLOCO; i++) {
      let s = 0;
      for (let c = 0; c < nCanais; c++) s += entrada[c][i];
      d[i] = s / nCanais;
    }
    xbuf.copyWithin(0, BLOCO);
    let energiaRef = 0;
    const nRef = ref ? ref.length : 0;
    for (let i = 0; i < BLOCO; i++) {
      let s = 0;
      for (let c = 0; c < nRef; c++) s += ref[c][i];
      s = nRef ? s / nRef : 0;
      xbuf[BLOCO + i] = s;
      energiaRef += s * s;
    }
    energiaRef /= BLOCO;

    // espectro do bloco de referência mais recente
    this.cabeca = (this.cabeca - 1 + PARTICOES) % PARTICOES;
    const Xre = this.Xre, Xim = this.Xim, Wre = this.Wre, Wim = this.Wim;
    const yRe = this.yRe, yIm = this.yIm, pot = this.pot;
    {
      const base = this.cabeca * BINS;
      for (let i = 0; i < TAM_FFT; i++) { yRe[i] = xbuf[i]; yIm[i] = 0; }
      this.fft(yRe, yIm, false);
      for (let k = 0; k < BINS; k++) { Xre[base + k] = yRe[k]; Xim[base + k] = yIm[k]; }
    }

    // eco estimado = soma das partições (peso x espectro do bloco correspondente)
    for (let k = 0; k < BINS; k++) { yRe[k] = 0; yIm[k] = 0; }
    for (let p = 0; p < PARTICOES; p++) {
      const bx = ((this.cabeca + p) % PARTICOES) * BINS, bw = p * BINS;
      for (let k = 0; k < BINS; k++) {
        const xr = Xre[bx + k], xi = Xim[bx + k];
        const wr = Wre[bw + k], wi = Wim[bw + k];
        yRe[k] += wr * xr - wi * xi;
        yIm[k] += wr * xi + wi * xr;
      }
    }
    this.espelhar(yRe, yIm);
    this.fft(yRe, yIm, true);
    const est = this.est;
    for (let i = 0; i < BLOCO; i++) est[i] = yRe[BLOCO + i];

    // saída = áudio da tela - eco estimado (em cada canal)
    for (let c = 0; c < saida.length; c++) {
      const src = entrada[Math.min(c, nCanais - 1)], dst = saida[c];
      for (let i = 0; i < BLOCO; i++) dst[i] = src[i] - est[i];
    }

    // adaptação: só quando há voz de referência tocando
    if (energiaRef > LIMIAR_REF) {
      // Trava de segurança: se a saída ficar bem mais "alta" que a entrada por um
      // tempo, o filtro está piorando o som (ex.: o caminho do eco mudou). Zera e recomeça.
      let eD = 0, eE = 0;
      for (let i = 0; i < BLOCO; i++) { const r = d[i] - est[i]; eD += d[i] * d[i]; eE += r * r; }
      this.enEntrada = 0.98 * this.enEntrada + eD;
      this.enSaida = 0.98 * this.enSaida + eE;
      if (this.enSaida > 2 * this.enEntrada + 1e-3) {
        Wre.fill(0); Wim.fill(0);
        this.enEntrada = 0; this.enSaida = 0;
      }

      const eRe = this.eRe, eIm = this.eIm;
      for (let i = 0; i < BLOCO; i++) { eRe[i] = 0; eIm[i] = 0; }
      for (let i = 0; i < BLOCO; i++) { eRe[BLOCO + i] = d[i] - est[i]; eIm[BLOCO + i] = 0; }
      this.fft(eRe, eIm, false);

      // Passo proporcional: partições onde o filtro já encontrou o eco (peso grande)
      // adaptam mais rápido. Assim o atraso real é aprendido em poucos instantes,
      // sem aumentar o ruído nas demais partições.
      const ganho = this.ganho;
      let totalW = 0;
      for (let p = 0; p < PARTICOES; p++) {
        let s = 0;
        const bw = p * BINS;
        for (let k = 0; k < BINS; k++) s += Wre[bw + k] * Wre[bw + k] + Wim[bw + k] * Wim[bw + k];
        ganho[p] = s + 1e-6;
        totalW += ganho[p];
      }
      for (let p = 0; p < PARTICOES; p++) {
        ganho[p] = ALFA + (1 - ALFA) * PARTICOES * (ganho[p] / totalW);
      }

      // potência do sinal de referência por frequência, ponderada pelo passo
      for (let k = 0; k < BINS; k++) pot[k] = 0;
      for (let p = 0; p < PARTICOES; p++) {
        const bx = ((this.cabeca + p) % PARTICOES) * BINS, g = ganho[p];
        for (let k = 0; k < BINS; k++) {
          pot[k] += g * (Xre[bx + k] * Xre[bx + k] + Xim[bx + k] * Xim[bx + k]);
        }
      }
      for (let k = 0; k < BINS; k++) pot[k] = MU / (pot[k] + REGULARIZACAO);

      for (let p = 0; p < PARTICOES; p++) {
        const bx = ((this.cabeca + p) % PARTICOES) * BINS, bw = p * BINS, g = ganho[p];
        for (let k = 0; k < BINS; k++) {
          const xr = Xre[bx + k], xi = Xim[bx + k];
          const er = eRe[k], ei = eIm[k], m = pot[k] * g;
          Wre[bw + k] += m * (xr * er + xi * ei);
          Wim[bw + k] += m * (xr * ei - xi * er);
        }
      }

      // Restrição: uma partição por bloco é "limpa" (mantém só os primeiros 128
      // pontos no tempo). Em rodízio, todas passam por isso a cada 96 blocos.
      const q = this.projecao;
      this.projecao = (this.projecao + 1) % PARTICOES;
      const bq = q * BINS;
      for (let k = 0; k < BINS; k++) { yRe[k] = Wre[bq + k]; yIm[k] = Wim[bq + k]; }
      this.espelhar(yRe, yIm);
      this.fft(yRe, yIm, true);
      for (let i = BLOCO; i < TAM_FFT; i++) { yRe[i] = 0; yIm[i] = 0; }
      for (let i = 0; i < BLOCO; i++) yIm[i] = 0;
      this.fft(yRe, yIm, false);
      for (let k = 0; k < BINS; k++) { Wre[bq + k] = yRe[k]; Wim[bq + k] = yIm[k]; }
    }
    return true;
  }
}

if (typeof registerProcessor === 'function') {
  registerProcessor('cancelador-eco', CanceladorEco);
}
if (typeof module !== 'undefined') module.exports = { CanceladorEco };
