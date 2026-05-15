require('dotenv').config()

const { Api, TelegramClient } = require("telegram");
const { NewMessage } = require("telegram/events");
const { StringSession } = require("telegram/sessions");
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const app = express();

const SESSIONS_DIR = path.join(__dirname, process.env.SESSIONS_DIR);
const PHOTOS_DIR = path.join(__dirname, process.env.PHOTOS_DIR);

app.use(cors());
app.use(express.json());
app.use("/photos", express.static(PHOTOS_DIR));


const PORT = process.env.PORT ? Number(process.env.PORT) : null;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const apiId = process.env.TELEGRAM_API_ID ? Number(process.env.TELEGRAM_API_ID) : null;
const apiHash = process.env.TELEGRAM_API_HASH;


if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
if (!fs.existsSync(PHOTOS_DIR)) fs.mkdirSync(PHOTOS_DIR, { recursive: true });

// Memória
const sessions = {};
const tempLogins = {};
const messages = [];

/* ================= UTIL ================= */

async function sendWebhook(url, payload) {
  if (!url) return;
  try {
    await axios.post(url, payload, {
      headers: { "Content-Type": "application/json" },
      timeout: 10000,
    });
    console.log("✅ Webhook enviado:", payload.event);
  } catch (err) {
    console.error("❌ Webhook erro:", err.message);
  }
}

function saveSession(nome, stringSession) {
  const file = path.join(SESSIONS_DIR, `${nome}.session`);
  fs.writeFileSync(file, stringSession, "utf8");
}

function readSession(nome) {
  const file = path.join(SESSIONS_DIR, `${nome}.session`);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
}

/* ================= LOGIN ================= */

app.post("/iniciar-login", async (req, res) => {
  const { nome, webhook, phoneNumber } = req.body;

  if (!nome || !phoneNumber) {
    return res.status(400).json({ error: "nome e phoneNumber são obrigatórios" });
  }

  try {
    const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
      connectionRetries: 5,
    });

    if (!client.connected) {
      await client.connect();
    }

    const result = await client.sendCode({ apiId, apiHash }, phoneNumber);

    tempLogins[phoneNumber] = {
      client,
      phoneCodeHash: result.phoneCodeHash,
      nome,
      webhook,
    };

    res.json({ status: "aguardando_codigo" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao enviar código" });
  }
});

app.post("/confirmar-codigo", async (req, res) => {
  const { phoneNumber, phoneCode, password } = req.body;
  const login = tempLogins[phoneNumber];

  if (!login) {
    return res.status(400).json({ error: "Login não encontrado" });
  }

  const { client, phoneCodeHash, nome, webhook } = login;

  try {
    await client.invoke(
      new Api.auth.SignIn({
        phoneNumber,
        phoneCodeHash,
        phoneCode,
      })
    );

    const sessionString = client.session.save();
    saveSession(nome, sessionString);

    delete tempLogins[phoneNumber];

      // remove cliente antigo se existir
      if (sessions[nome]?.client) {
        try {
          await sessions[nome].client.destroy();
        } catch {}
      }

      sessions[nome] = {
        client,
        webhook,
        isConfirmed: true,
      };

    await sendWebhook(webhook, {
      event: "instance.connected",
      provider: "telegram",
      nome,
      session_string: sessionString,
      phoneNumber,
      ds_auth_path: path.join(SESSIONS_DIR, `${nome}.session`),
    });

    startListeners(client, nome, webhook);

    res.json({ status: "conectado" });

  } catch (err) {

    // 🔐 2FA
    if (err.errorMessage === "SESSION_PASSWORD_NEEDED") {
      try {
        await client.invoke(new Api.auth.CheckPassword({ password }));

        const sessionString = client.session.save();
        saveSession(nome, sessionString);

        sessions[nome] = { client, webhook, isConfirmed: true };

        startListeners(client, nome, webhook);

        return res.json({ status: "conectado_com_password" });
      } catch {
        return res.status(401).json({ error: "Senha incorreta" });
      }
    }

    console.error(err);
    res.status(500).json({ error: "Erro no login" });
  }
});

/* ================= LISTENERS ================= */

function startListeners(client, nome, webhook) {

  // remove listeners antigos
  client.removeEventHandler(handler)

  // desconexão
  client.addEventHandler(async (update) => {
    if (
      update.className === "UpdateConnectionState" &&
      update.state === "closed"
    ) {
      await sendWebhook(webhook, {
        event: "instance.disconnected",
        provider: "telegram",
        nome,
      });
    }
  });

  // mensagens
  client.addEventHandler(
    async (event) => {
      const message = event.message;

      if (!message) return;

      let sender = null;
      let photoPath = null;

      try {
        if (message.senderId) {
          sender = await client.getEntity(message.senderId);
        }

        if (sender) {
          const photo = await client.downloadProfilePhoto(sender);

          if (photo) {
            const fileName = `${sender.id}.jpg`;

            const fullPath = path.join(PHOTOS_DIR, fileName);

            fs.writeFileSync(fullPath, photo);

            photoPath = `${BASE_URL.replace(/\/$/, '')}/photos/${fileName}`;
          }
        }
      } catch (err) {
        console.warn("⚠️ erro ao obter sender:", err.message);
      }

      const contact = sender
        ? {
            id: sender.id?.toString(),
            firstName: sender.firstName,
            lastName: sender.lastName,
            username: sender.username,
            phone: sender.phone,
            photo: photoPath,
          }
        : null;

      const payload = {
        event: "message.received",
        provider: "telegram",
        nome,
        instance: { name: nome },
        message,
        fromMe: message.out || false,
        contact,
      };

      messages.push(payload);

      await sendWebhook(webhook, payload);

    },
    new NewMessage({})
  );
}

/* ================= RESTORE ================= */

(async () => {
  const files = fs.readdirSync(SESSIONS_DIR);

  for (const file of files) {
    const nome = path.basename(file, ".session");
    const sessionData = readSession(nome);

    if (!sessionData) continue;

    const client = new TelegramClient(
      new StringSession(sessionData),
      apiId,
      apiHash,
      { connectionRetries: 5 }
    );

    try {

      // evita duplicar sessão
      if (sessions[nome]?.client) {
        console.log(`⚠️ Sessão já ativa: ${nome}`);
        continue;
      }

      if (!client.connected) {
        await client.connect();
      }

      sessions[nome] = {
        client,
        webhook: null,
        isConfirmed: true,
      };

      startListeners(client, nome, null);

      console.log("♻️ Restaurado:", nome);

    } catch (err) {

      console.error(`❌ Erro restaurando ${nome}:`, err.message);

      // sessão corrompida ou duplicada
      if (
        err.errorMessage === "AUTH_KEY_DUPLICATED" ||
        err.message?.includes("AUTH_KEY_DUPLICATED")
      ) {

        console.log(`🗑️ Removendo sessão inválida: ${nome}`);

        fs.unlinkSync(path.join(SESSIONS_DIR, file));
      }
    }
  }
})();

    process.on("SIGINT", async () => {
    console.log("🔌 Encerrando Telegram clients...");

    for (const nome in sessions) {
      try {
        await sessions[nome].client.destroy();
      } catch {}
    }

    process.exit(0);
  });

/* ================= SEND MESSAGE ================= */

app.post("/send-message", async (req, res) => {
  const { nome, number, userId, message } = req.body;
  const session = sessions[nome];

  if (!session) {
    return res.status(400).json({ error: "Sessão não encontrada" });
  }

  try {
    let entity;

    if (number) {
      const formatted = number.startsWith("+") ? number : `+${number}`;

      try {
        entity = await session.client.getEntity(formatted);
      } catch {
        const result = await session.client.invoke(
          new Api.contacts.ImportContacts({
            contacts: [
              new Api.InputPhoneContact({
                clientId: Date.now(),
                phone: formatted,
                firstName: "Contato",
              }),
            ],
          })
        );

        entity = result.users[0];
      }

    } else if (userId) {

      const user = await session.client.getEntity(userId);

      entity = new Api.InputPeerUser({
        userId: BigInt(user.id),
        accessHash: user.accessHash,
      });

    } else {
      return res.status(400).json({ error: "Informe number ou userId" });
    }

    const result = await session.client.sendMessage(entity, { message });

    await sendWebhook(session.webhook, {
      event: "message.sent",
      provider: "telegram",
      nome,
      telegram: {
        messageId: result.id,
        peerId: result.peerId,
        date: result.date,
      },
      message: { text: message },
      fromMe: true,
    });

    res.json({ success: true });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* ================= STATUS ================= */

app.get("/status/:nome", (req, res) => {
  const session = sessions[req.params.nome];

  if (!session) {
    return res.status(404).json({ error: "Sessão não encontrada" });
  }

  res.json({
    conectado: !!session.client.connected,
    webhook: session.webhook,
  });
});

/* ================= SERVER ================= */

app.listen(PORT, () => {
  console.log(`🚀 Telegram bot rodando na porta ${PORT}`);
});