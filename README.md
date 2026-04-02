# Predictive Launch Engine - Solana

Sistema avançado de previsão de lançamento de memecoins na rede Solana usando IA e dados on-chain.

---

## Como Rodar - Passo a Passo

### Pré-requisitos

- Node.js 18+
- npm
- Conexão com internet

### 1. Instalar dependências

```bash
npm install
```

### 2. Setup inicial

```bash
npm run setup
```

Isso vai:
- Criar o arquivo `.env` a partir do `.env.example`
- Inicializar o banco de dados SQLite
- Treinar o modelo inicial com dados sintéticos

### 3. Configurar APIs (`.env`)

Edite o arquivo `.env` com suas chaves:

```env
# Obrigatório - Solana RPC (use um privado para melhor performance)
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com

# Recomendado - para dados enriquecidos
HELIUS_API_KEY=sua_chave_aqui          # https://dev.helius.xyz

# Para sinais sociais
TWITTER_BEARER_TOKEN=seu_token_aqui    # https://developer.twitter.com
TELEGRAM_BOT_TOKEN=seu_token_aqui      # @BotFather no Telegram
TELEGRAM_ALERT_CHAT_ID=seu_chat_id

# Para alertas Telegram - descubra seu chat ID:
# 1. Crie um bot via @BotFather
# 2. Envie /start para o bot
# 3. Acesse: https://api.telegram.org/bot<TOKEN>/getUpdates
```

### 4. Iniciar o sistema

```bash
npm start
```

### 5. Acessar o dashboard

```
http://localhost:3000
```

---

## Configuração de APIs

### Helius (recomendado)
- Acesse: https://dev.helius.xyz
- Crie uma conta gratuita
- Copie a API Key para `HELIUS_API_KEY`
- Oferece WebSockets enriquecidos e parsing de transações

### Twitter/X
- Acesse: https://developer.twitter.com
- Crie um App no portal de developers
- Gere Bearer Token (acesso Basic gratuito é suficiente)
- Preencha `TWITTER_BEARER_TOKEN`

### Telegram
- Abra o Telegram e procure @BotFather
- Envie `/newbot` e siga as instruções
- Copie o token para `TELEGRAM_BOT_TOKEN`
- Para descobrir seu `TELEGRAM_ALERT_CHAT_ID`:
  1. Inicie conversa com seu bot
  2. Acesse: `https://api.telegram.org/bot<TOKEN>/getUpdates`
  3. Copie o `chat.id` da resposta

### RPC Privado (recomendado para produção)
Provedores sugeridos:
- Helius: https://dev.helius.xyz (inclui na conta gratuita)
- QuickNode: https://www.quicknode.com
- Alchemy: https://www.alchemy.com

---

## Como Treinar o Modelo

### Treinamento inicial (automático)
```bash
npm run train
```
Isso gera 200 amostras sintéticas baseadas em padrões conhecidos e treina o modelo.

### Treinamento com dados reais
Conforme o sistema detecta lançamentos, registre os resultados reais:

1. No dashboard, clique em qualquer lançamento
2. Clique em "Record Outcome"
3. Informe o multiplicador de pico (ex: 5.2 para 5.2x)

O sistema re-treina automaticamente a cada 24 horas com os dados acumulados.

### Via API
```bash
curl -X POST http://localhost:3000/api/launches/<launch_id>/outcome \
  -H "Content-Type: application/json" \
  -d '{"peakMultiplier": 5.2, "tokenAddress": "..."}'
```

---

## Como Interpretar os Scores

### Score de Pump (0-100%)

| Range | Significado |
|-------|-------------|
| 85-100% | HIGH PRIORITY - Múltiplos sinais fortes convergindo |
| 70-84% | MEDIUM - Sinais relevantes, monitorar de perto |
| 50-69% | LOW - Alguns sinais, mas inconclusivo |
| < 50% | Abaixo do threshold de alerta |

### Sub-scores

- **Dev Score**: Histórico do desenvolvedor. Devs com lançamentos lucrativos anteriores = score alto
- **On-chain Score**: Intensidade de preparação na blockchain (movimentações, interações com DEX)
- **Social Score**: Crescimento de menções e sentimento positivo no Twitter/Telegram
- **Capital Score**: Volume de SOL sendo acumulado por carteiras relacionadas
- **Similarity Score**: Similaridade com padrões de lançamentos bem-sucedidos anteriores

### Risk Score

- 🟢 0-50%: Risco controlado
- 🟡 50-70%: Risco moderado
- 🔴 70-100%: Alto risco (típico de memecoins - nunca invista mais do que pode perder)

---

## Como Conectar com Bot de Trading

O sistema envia sinais para bots externos via webhook. O bot decide se executa ou não.

### Configuração

```env
TRADING_BOT_WEBHOOK_URL=https://seu-bot.com/webhook
TRADING_BOT_SECRET=chave_secreta_para_verificar
```

### Payload enviado ao bot

```json
{
  "type": "PRE_LAUNCH_ENTRY",
  "launchId": "uuid",
  "devWallet": "abc123...",
  "tokenAddress": null,
  "prediction": {
    "pumpProbability": 0.87,
    "riskScore": 0.45,
    "priority": "HIGH"
  },
  "scores": {
    "dev": 0.82,
    "onchain": 0.91,
    "social": 0.65,
    "capital": 0.78
  },
  "suggestedAction": {
    "action": "WATCH_AND_BUY_ON_LAUNCH",
    "note": "Buy immediately when liquidity is detected"
  }
}
```

### Verificação de assinatura

```javascript
const crypto = require('crypto');
const signature = req.headers['x-signature'];
const expected = crypto.createHash('sha256')
  .update(JSON.stringify(payload) + process.env.TRADING_BOT_SECRET)
  .digest('hex');
// signature === expected -> payload autêntico
```

---

## Arquitetura dos Módulos

```
src/
├── index.js                 # Orquestrador principal
├── config/config.js         # Configurações centralizadas
├── database/db.js           # SQLite com WAL mode
├── utils/logger.js          # Winston logger
└── modules/
    ├── onchainScanner.js    # WebSocket + polling da Solana
    ├── devCluster.js        # Agrupamento de carteiras por dev
    ├── socialAnalyzer.js    # Twitter + Telegram NLP
    ├── preLaunchDetector.js # Agrega sinais e cria detecções
    ├── scoringEngine.js     # Regressão logística + heurísticas
    ├── alertSystem.js       # Telegram + WebSocket + Webhook
    ├── learningSystem.js    # Treino contínuo do modelo
    └── integrationModule.js # Integração com bots de trading
```

---

## API Endpoints

| Método | Endpoint | Descrição |
|--------|----------|-----------|
| GET | `/api/status` | Status do sistema e do modelo |
| GET | `/api/launches?status=pre_launch` | Lançamentos detectados |
| GET | `/api/launches/:id` | Detalhes + eventos de um lançamento |
| POST | `/api/launches/:id/outcome` | Registrar resultado real |
| POST | `/api/launches/:id/rescore` | Re-pontuar um lançamento |
| GET | `/api/devs` | Top desenvolvedores |
| GET | `/api/alerts` | Histórico de alertas |
| GET | `/api/performance` | Métricas de performance do modelo |

---

## Segurança

- Nenhuma chave privada é armazenada ou processada
- O módulo de execução apenas envia sinais - a decisão de compra é do bot externo
- Todas as operações de trading são delegadas via webhook assinado
- Rate limiting em todos os endpoints da API

---

## Aviso Legal

Este sistema é para fins educacionais e de pesquisa. Memecoins são investimentos de altíssimo risco. Nunca invista mais do que está disposto a perder totalmente. Previsões do sistema não são garantias de retorno financeiro.
