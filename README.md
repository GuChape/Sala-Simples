# Sala Simples

Uma sala de conversa minimalista que roda inteira no navegador: **chat, canal de voz, compartilhamento de tela e envio de arquivos grandes**, sem cadastro, sem servidor próprio e sem guardar nada.

🔗 **Acesse:** https://guchape.github.io/Sala-Simples-/

## Funcionalidades

- **Salas por código:** basta compartilhar o link (`...#codigo-da-sala`) para outras pessoas entrarem.
- **Chat em tempo real:** as mensagens existem só enquanto a aba está aberta. Nada é gravado.
- **Canal de voz:** entrar, sair e silenciar o microfone.
- **Compartilhamento de tela:** transmita uma tela, janela ou aba para quem está na sala.
- **Envio de arquivos grandes:** o arquivo vai direto de um navegador para o outro, em pedaços, com barra de progresso.
- **Sem conta e sem instalação:** funciona em navegadores modernos (Chrome, Edge, Firefox) no computador.

## Como usar

1. Abra a página, escreva seu nome e um código de sala (ou gere um aleatório).
2. Clique em **Copiar link da sala** e envie para quem vai participar.
3. Use o chat, o botão de voz, o de tela e o 📎 para enviar arquivos.

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
