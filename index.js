//telegram-bot/index.js
const { Api, TelegramClient } = require("telegram");
const { NewMessage } = require("telegram/events");
const { StringSession } = require("telegram/sessions");
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3002;

// Credenciais Telegram
const apiId = 20637774;
const apiHash = "030aaf9610ff135dd84423742007daf4";

// Diretório de sessões
const SESSIONS_DIR = path.join(__dirname, "sessions");
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// Sessões em memória
const sessions = {};
const tempLogins = {}; // guarda { phoneNumber: { client, phoneCodeHash } }
const messages = [];

/* -------------------- Funções utilitárias -------------------- */

async function sendWebhook(url, payload) {
  if (!url) return;
  try {
    await axios.post(url, payload, { headers: { "Content-Type": "application/json" }, timeout: 10000 });
    console.log("✅ Webhook enviado:", payload.acao || "mensagem");
  } catch (err) {
    console.error("❌ Erro ao enviar webhook:", err.message);
  }
}

function saveSession(nome, stringSession) {
  const file = path.join(SESSIONS_DIR, `${nome}.session`);
  fs.writeFileSync(file, stringSession, "utf8");
  console.log("💾 Sessão salva:", file);
}

function readSession(nome) {
  const file = path.join(SESSIONS_DIR, `${nome}.session`);
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8");
  return null;
}

/* -------------------- Login em duas etapas -------------------- */

// Etapa 1: iniciar login (envia código para o Telegram)
app.post("/iniciar-login", async (req, res) => {
  const { nome, webhook, phoneNumber } = req.body;
  if (!nome || !phoneNumber) return res.status(400).json({ error: "nome e phoneNumber são obrigatórios" });

  try {
    const stringSession = new StringSession("");
    const client = new TelegramClient(stringSession, apiId, apiHash, { connectionRetries: 5 });
    await client.connect();

    console.log(`📞 Enviando código para ${phoneNumber}...`);
    const result = await client.sendCode({ apiId, apiHash }, phoneNumber);

    tempLogins[phoneNumber] = { client, phoneCodeHash: result.phoneCodeHash, nome, webhook };
    res.json({ status: "aguardando_codigo", phoneNumber });
  } catch (err) {
    console.error("❌ Erro iniciar login:", err);
    res.status(500).json({ error: "Falha ao enviar código" });
  }
});

// Etapa 2: confirmar código recebido
app.post("/confirmar-codigo", async (req, res) => {
  const { phoneNumber, phoneCode, password } = req.body;
  const loginData = tempLogins[phoneNumber];
  if (!loginData) return res.status(400).json({ error: "Sessão de login não encontrada" });

  const { client, phoneCodeHash, nome, webhook } = loginData;

  try {
    await client.invoke(
      new Api.auth.SignIn({
        phoneNumber,
        phoneCodeHash,
        phoneCode,
      })
    );

    console.log("✅ Login Telegram bem-sucedido!");

    const sessionString = client.session.save();
    saveSession(nome, sessionString);

    delete tempLogins[phoneNumber];
    sessions[nome] = { client, webhook, isConfirmed: true };

    // Webhook de sucesso
    await sendWebhook(webhook, {
      event: "instance.connected",
      provider: "telegram",
      nome,
      session_string: sessionString,
      phoneNumber,
      webhook,
      ds_auth_path: path.join(SESSIONS_DIR, `${nome}.session`),
      createdAt: new Date().toISOString()
    });

    // Escutar desconexões
    client.addEventHandler(async (update) => {
      if (update.className === "UpdateConnectionState" && update.state === "closed") {
        await sendWebhook(webhook, {
          event: "instance.disconnected",
          provider: "telegram",
          nome
        })
      }
    })

    // Escutar mensagens
    client.addEventHandler(
      async (event) => {
        const message = event.message;
        if (!message) return;

        message.instance = {
          name: nome
        };
        
        messages.push(message); // Armazena a mensagem completa localmente

        // Envia o objeto completo para a API
        await sendWebhook(webhook, {
          event: "message.received",
          provider: "telegram",
          nome,
          instance: {
            name: nome
          },
          message,
          fromMe: false
        });
      },
      new NewMessage({})
    );

    res.json({ status: "conectado", nome, sessionString });
  } catch (err) {
    if (err.error_message === "SESSION_PASSWORD_NEEDED" || err.errorMessage === "SESSION_PASSWORD_NEEDED") {
      try {
        await client.invoke(new Api.auth.CheckPassword({ password }));
        const sessionString = client.session.save();
        saveSession(nome, sessionString);
        res.json({ status: "conectado_com_password", nome });
      } catch (e) {
        res.status(401).json({ error: "Senha incorreta" });
      }
    } else {
      console.error("❌ Erro confirmar código:", err);
      res.status(500).json({ error: "Falha ao confirmar código" });
    }
  }
});

/* -------------------- Recarregar sessões salvas -------------------- */
(async () => {
  const files = fs.readdirSync(SESSIONS_DIR);
  for (const file of files) {
    const nome = path.basename(file, ".session");
    const sessionData = readSession(nome);
    if (!sessionData) continue;

    const client = new TelegramClient(new StringSession(sessionData), apiId, apiHash, { connectionRetries: 5 });
    await client.connect();

    await sendWebhook(process.env.API_WEBHOOK_URL, {
      event: "instance.connected",
      provider: "telegram",
      nome,
      session_string: sessionData,
      phoneNumber: null,
      webhook: null,
      ds_auth_path: path.join(SESSIONS_DIR, `${nome}.session`),
      createdAt: new Date().toISOString()
    });

    sessions[nome] = { client, webhook: null, isConfirmed: true };
    console.log(`♻️ Sessão restaurada: ${nome}`);
  }
})();

/* -------------------- Função Auxiliar -------------------- */

function buildInlineKeyboard(buttons) {
  if (!buttons || !Array.isArray(buttons) || buttons.length === 0) return [];

  return buttons.map((row) => 
    new Api.KeyboardButtonRow({
      buttons: row.map((btn) => {
        if (btn.url) {
          return new Api.KeyboardButtonUrl({
            text: btn.text,
            url: btn.url,
          });
        } else {
          return new Api.KeyboardButtonCallback({
            text: btn.text,
            data: Buffer.from(btn.callback_data || btn.text, "utf-8"),
          });
        }
      }),
    })
  );
}


/* -------------------- Enviar mensagem -------------------- */

app.post("/send-message", async (req, res) => {
  const { nome, number, userId, message } = req.body;
  const session = sessions[nome];

  if (!session) {
    return res.status(400).json({ error: "Sessão não encontrada" });
  }

  try {
    let entity;

    if (number) {
      // 🔹 Caso tenha número, formata corretamente
      const formattedNumber = number.startsWith("+") ? number : `+${number}`;

      try {
        entity = await session.client.getEntity(formattedNumber);
      } catch {
        // Caso não exista, importa o contato
        const result = await session.client.invoke(
          new Api.contacts.ImportContacts({
            contacts: [
              new Api.InputPhoneContact({
                clientId: Date.now(),
                phone: formattedNumber,
                firstName: "Contato",
                lastName: "",
              }),
            ],
          })
        );

        entity = result.users[0];
      }
    } else if (userId) {
      // 🔹 Caso tenha apenas o ID do usuário
      const userEntity = await session.client.getEntity(userId);

      entity = new Api.InputPeerUser({
        userId: BigInt(userEntity.id),
        accessHash: userEntity.accessHash,
      });
    } else {
      return res.status(400).json({
        error: "É necessário informar 'number' ou 'userId' no corpo da requisição.",
      });
    }

    // 🟩 Envia a mensagem
    const result = await session.client.sendMessage(entity, { message });

    // 🔹 Envia webhook
    const payload = {
      event: "message.sent",
      provider: "telegram",

      nome,

      instance: {
        name: nome
      },

      telegram: {
        messageId: result.id,
        peerId: result.peerId,
        date: result.date,
      },

      message: {
        type: "text",
        text: message,
        raw: result
      },

      fromMe: true,
      timestamp: result.date ? result.date * 1000 : Date.now()
    };

    console.log("\n========== PAYLOAD TELEGRAM SENDMESSAGE ==========");
    console.log(JSON.stringify(payload, null, 2));
    console.log("=================================================\n");

    await sendWebhook(session.webhook, payload);

    res.json({ status: true, msg: "Mensagem enviada com sucesso" });
  } catch (err) {
    console.error("❌ Erro ao enviar mensagem:", err);
    res.status(500).json({ error: err.message });
  }
});


/* -------------------- Status da instância -------------------- */
app.get("/status/:nome", (req, res) => {
  const { nome } = req.params;
  const session = sessions[nome];
  if (!session) return res.status(404).json({ error: "Sessão não encontrada" });

  res.json({
    nome,
    conectado: !!session.client.connected,
    webhook: session.webhook,
    isConfirmed: session.isConfirmed,
  });
});

/* -------------------- Listar mensagens -------------------- */
app.get("/received-messages", (req, res) => {
  res.json({ total: messages.length, mensagens: messages });
});


/* -------------------- Iniciar servidor -------------------- */
app.listen(PORT, () => console.log(`🚀 Servidor rodando em http://localhost:${PORT}`));
