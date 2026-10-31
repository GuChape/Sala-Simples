# Sala Simples

Uma sala de conversa minimalista que roda inteira no navegador: **chat, canal de voz, compartilhamento de tela e envio de arquivos grandes**, sem cadastro, sem servidor próprio e sem guardar nada.

🔗 **Acesse:** https://guchape.github.io/Sala-Simples/

## Funcionalidades

- **Cor e emoji para cada pessoa:** ao entrar, você recebe uma cor e um emoji aleatórios que aparecem ao lado do seu nome no chat. Em uma mesma sala, duas pessoas nunca ficam com a mesma cor.
- **Salas por código:** basta compartilhar o link (`...#codigo-da-sala`) para outras pessoas entrarem.
- **Chat em tempo real:** as mensagens existem só enquanto a aba está aberta. Nada é gravado.
- **Voice chat opcional:** ao entrar na sala você não ouve ninguém. Só quem clica em **Entrar no Voice chat** fala e ouve; dá para silenciar o microfone e sair quando quiser. O 🎙️ aparece ao lado de quem está no Voice chat. O áudio usa Opus em alta qualidade, com supressão de ruído.
- **Compartilhamento de tela:** transmita uma tela, janela ou aba para quem está na sala, com som, em três níveis de qualidade (1080p 60 fps, 720p 60 fps ou 1080p 30 fps).
- **Envio de arquivos grandes:** o arquivo vai direto de um navegador para o outro, em pedaços, com barra de progresso.
- **Sem conta e sem instalação:** funciona em navegadores modernos (Chrome, Edge, Firefox) no computador.

## Como usar

1. Abra a página, escreva seu nome e um código de sala (ou gere um aleatório).
2. Clique em **Copiar link da sala** e envie para quem vai participar.
3. Use o chat, o Voice chat, o botão de tela e o 📎 para enviar arquivos.

## Como funciona

O projeto usa [PeerJS](https://peerjs.com/), uma biblioteca sobre **WebRTC**, a tecnologia que permite conexão direta entre navegadores.

- Cada pessoa ocupa uma "vaga" da sala (até 6). O ID de cada vaga é derivado do código da sala.
- Ao entrar, o navegador tenta se conectar a todas as outras vagas, formando uma malha em que todos falam com todos.
- Cada par de pessoas tem uma conexão de dados (chat e arquivos) e, quando necessário, chamadas de mídia (voz e tela).
- O servidor público do PeerJS é usado **apenas para apresentar os navegadores uns aos outros**. Mensagens, arquivos, áudio e vídeo trafegam direto entre os participantes.

### Envio de arquivos

O arquivo é cortado em pedaços de 64 KB e enviado pelo canal de dados do WebRTC, com controle de fluxo para não sobrecarregar a conexão. Quem recebe remonta o arquivo e libera o download ao final.

## Privacidade

- Não há banco de dados nem registro de conversas: tudo fica apenas na memória das abas abertas.
- Não há login. Quem tiver o código da sala consegue entrar, então use códigos difíceis de adivinhar em conversas privadas.
- As conexões são criptografadas pelo próprio WebRTC.

## Limitações

- **Tamanho da sala:** até 6 pessoas. Como todos se conectam a todos, a voz e a tela consomem mais internet de quem transmite conforme a sala cresce. Funciona melhor com 2 a 4 pessoas.
- **Arquivos:** quem envia precisa manter a aba aberta até o fim. Quem recebe guarda o arquivo na memória antes de baixar, então arquivos de vários GB podem travar computadores com pouca RAM.
- **Redes restritivas:** em algumas redes (empresas, faculdades, certos 4G) a conexão direta pode falhar. A solução é configurar um servidor TURN na lista `iceServers` do `app.js`.
- **Dependência externa:** o servidor gratuito do PeerJS pode ficar instável ou indisponível ocasionalmente.

## Dicas

- **Fones de ouvido:** marque "Estou de fones" para desligar o cancelamento de eco; a voz fica mais natural. Sem fones, deixe desmarcado: com o eco desligado, o som que sai das caixas de som entra no microfone e os outros ouvem.
- **Som na transmissão de tela:** ao compartilhar, escolha "Tela inteira" e deixe ativo "Compartilhar áudio do sistema" (Windows), ou escolha uma "Guia" e ative "Compartilhar áudio da guia". Janelas e o Firefox não enviam som, e no Mac só o som de uma guia do Chrome/Edge funciona. A legenda do vídeo mostra 🔊 (com som) ou 🔇 (sem som). Se você compartilha o som do sistema sem fones, quem assiste também ouve a voz dos outros que sai das suas caixas.
- **Qualidade da tela:** escolha antes de compartilhar. "1080p 30 fps" é melhor para texto e slides; "720p 60 fps" é mais leve se a internet de quem transmite for lenta.
- **Windows diminuindo outros sons enquanto você fala:** é uma configuração do sistema. Vá em *Painel de Controle → Som → aba Comunicações* e marque "Não fazer nada".

## Estrutura do projeto

```
├── index.html   # estrutura da página
├── style.css    # estilo
├── app.js       # chat, voz, tela, arquivos e conexão P2P
└── README.md
```

## Rodando localmente

Não há dependências para instalar. Como microfone e captura de tela exigem `localhost` ou HTTPS, sirva a pasta com um servidor simples:

```bash
python -m http.server 8000
```

Depois abra `http://localhost:8000`.

## Tecnologias

HTML, CSS e JavaScript puro, com [PeerJS](https://peerjs.com/) (WebRTC).
