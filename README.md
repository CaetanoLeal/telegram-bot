# 🤖 Container Telegram Bot – Instance Manager

Este container é responsável **exclusivamente por gerenciar instâncias do Telegram** e atuar como **ponte** entre o Telegram e a API principal (`api_mensagem`).

Ele **não possui lógica de negócio**, **não decide fluxo**, **não interpreta mensagens**.
Toda decisão é delegada para a API principal via webhook.

---

## 🎯 Objetivo

- Conectar contas do Telegram (login em 2 etapas)
- Manter sessões persistentes
- Escutar mensagens recebidas
- Enviar mensagens sob comando externo
- Encaminhar **eventos brutos** para a API principal via HTTP POST

---

## 📦 Papel na Arquitetura Geral

```
[ Telegram App ]
      ↓
[ telegram-bot ]  ← Instance Manager
      ↓  (webhook POST)
[ api_mensagem ]  ← Regras de negócio
```

Este container é **stateless do ponto de vista de negócio**, mas **stateful em sessões**.

---

## 🧱 Stack Utilizada

- Node.js
- Express
- telegram (MTProto)
- Axios
- File System (persistência de sessão)

---

## 📁 Estrutura de Sessões

As sessões do Telegram são salvas localmente em disco:

```
/sessions
 ├── nome_da_instancia.session
 ├── outra_instancia.session
```

- Cada sessão é identificada por um `nome`
- Sessões são restauradas automaticamente ao subir o container

---

## 🔑 Conceitos Importantes

### Instância

Uma **instância** representa uma conta Telegram conectada.

Campos-chave:

- `nome` → identificador único da instância
- `stringSession` → sessão persistente do Telegram
- `webhook` → URL da API principal (`api_mensagem`)

---

## 🔐 Login em Duas Etapas

### Etapa 1 – Iniciar Login

**Endpoint**

```
POST /iniciar-login
```

**Body**

```json
{
  "nome": "empresa_x",
  "phoneNumber": "+559199999999",
  "webhook": "http://api_mensagem/webhook/telegram"
}
```

**Comportamento**

- Conecta ao Telegram
- Envia código SMS / Telegram
- Armazena sessão temporária em memória (`tempLogins`)

---

### Etapa 2 – Confirmar Código

**Endpoint**

```
POST /confirmar-codigo
```

**Body**

```json
{
  "phoneNumber": "+559199999999",
  "phoneCode": "12345",
  "password": "opcional_se_2fa"
}
```

**Comportamento**

- Confirma login
- Gera `stringSession`
- Persiste sessão em disco
- Registra instância em memória
- Dispara webhook de sucesso para a API principal

**Webhook enviado**

```json
{
  "acao": "nova_instancia",
  "nome": "empresa_x",
  "status": "conectado",
  "stringSession": "..."
}
```

---

## 🔁 Restauração Automática de Sessões

Ao iniciar o container:

- Lê todos os arquivos `.session`
- Reconecta automaticamente cada instância
- Marca como `isConfirmed: true`

⚠️ O webhook não é persistido no disco, apenas em memória.

---

## 📩 Recebimento de Mensagens

Após login bem-sucedido:

- O container escuta eventos `NewMessage`
- Cada mensagem recebida é:
  - armazenada localmente (debug)
  - enviada **integralmente** para a API principal via webhook

Nenhuma interpretação é feita aqui.

---

## 📤 Envio de Mensagens

**Endpoint**

```
POST /send-message
```

**Body (por número)**

```json
{
  "nome": "empresa_x",
  "number": "559199999999",
  "message": "Olá!"
}
```

**Body (por userId)**

```json
{
  "nome": "empresa_x",
  "userId": "123456789",
  "message": "Olá!"
}
```

**Regras**

- O envio só acontece se a instância existir
- O contato é importado automaticamente se necessário
- Após envio, um webhook opcional é disparado

---

## 📡 Status da Instância

**Endpoint**

```
GET /status/:nome
```

**Resposta**

```json
{
  "nome": "empresa_x",
  "conectado": true,
  "webhook": "...",
  "isConfirmed": true
}
```

---

## 📚 Listagem de Mensagens (Debug)

**Endpoint**

```
GET /received-messages
```

Retorna todas as mensagens recebidas desde o start do container.

---

## 🚫 O Que Este Container NÃO Faz

- ❌ Não controla funil
- ❌ Não valida regras de negócio
- ❌ Não interpreta mensagens
- ❌ Não mantém estado conversacional

Tudo isso é responsabilidade da **API principal (`api_mensagem`)**.

---

## ✅ Status do Documento

✔ README oficial do container Telegram
✔ Define claramente responsabilidades
✔ Serve como base para integração com frontend e API

---

📌 Próximo passo sugerido:

- README do **chatbot-erp (WhatsApp Instance Manager)**
- README do **Banco de Dados**
- Mapeamento de eventos Telegram → API
