import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
} from "discord.js";
import { google } from "googleapis";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import http from "http";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CREDENTIALS_PATH = path.join(__dirname, "credentials.json");
const TOKEN_PATH = path.join(__dirname, "token.json");
const CONFIG_PATH = path.join(__dirname, "config.json");

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const SCOPES = ["https://www.googleapis.com/auth/youtube"];

// --- ระบบบันทึกโหวต Skip แบบชั่วคราว ---
let voteSkipUsers = new Set<string>();
const REQUIRED_VOTES = 3; // สามารถเปลี่ยนจำนวนคนโหวตตรงนี้ได้

interface BotConfig {
  playlistId: string | null;
}

function loadConfig(): BotConfig {
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    } catch {
      return { playlistId: process.env.PLAYLIST_ID ?? null };
    }
  }
  return { playlistId: process.env.PLAYLIST_ID ?? null };
}

function saveConfig(config: BotConfig) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

function getYouTubeOAuth2Client() {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error(
      "ไม่พบไฟล์ credentials.json ในเครื่อง กรุณาใส่ไฟล์ก่อนรันบอท",
    );
  }
  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf8"));
  const { client_secret, client_id, redirect_uris } = credentials.installed;
  return new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
}

function getYouTubeClient() {
  if (!fs.existsSync(TOKEN_PATH)) {
    throw new Error(
      "บอทยังไม่ได้ล็อกอินบัญชี YouTube Host กรุณาใช้คำสั่ง `/setup_host` บน Discord",
    );
  }
  const oAuth2Client = getYouTubeOAuth2Client();
  const token = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"));
  oAuth2Client.setCredentials(token);
  return google.youtube({ version: "v3", auth: oAuth2Client });
}

function extractVideoId(url: string): string | null {
  const regExp =
    /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/;
  const match = url.match(regExp);
  const videoId = match?.[2];
  return videoId && videoId.length === 11 ? videoId : null;
}

// ─── YOUTUBE INTERACTION FUNCTIONS ──────────────────────────────────────────

async function addSongToPlaylist(videoId: string) {
  const config = loadConfig();
  if (!config.playlistId)
    throw new Error("ยังไม่ได้ตั้งค่าไอดี Playlist ปลายทาง");
  const youtube = getYouTubeClient();
  const response = await youtube.playlistItems.insert({
    part: ["snippet"],
    requestBody: {
      snippet: {
        playlistId: config.playlistId,
        resourceId: { kind: "youtube#video", videoId: videoId },
      },
    },
  });
  return response.data.snippet;
}

async function createNewYouTubePlaylist(title: string, privacyStatus: string) {
  const youtube = getYouTubeClient();
  const response = await youtube.playlists.insert({
    part: ["snippet", "status"],
    requestBody: {
      snippet: {
        title: title,
        description: "เพลย์ลิสต์นี้สร้างอัตโนมัติโดย Discord jookCast Bot",
      },
      status: { privacyStatus: privacyStatus },
    },
  });
  return response.data.id;
}

// ดึงรายการเพลงใน Playlist
async function getPlaylistSongs(maxResults = 10) {
  const config = loadConfig();
  if (!config.playlistId) throw new Error("ยังไม่ได้ตั้งค่าไอดี Playlist");
  const youtube = getYouTubeClient();
  const response = await youtube.playlistItems.list({
    part: ["snippet", "id"],
    playlistId: config.playlistId,
    maxResults: maxResults,
  });
  return response.data.items || [];
}

// ลบเพลงตาม ID ของรายการใน Playlist
async function removeSongFromPlaylist(playlistItemId: string) {
  const youtube = getYouTubeClient();
  await youtube.playlistItems.delete({ id: playlistItemId });
}

// ─── REGISTER SLASH COMMANDS ────────────────────────────────────────────────

const commands = [
  new SlashCommandBuilder()
    .setName("add")
    .setDescription("หยอดเพลงลงตู้คิวคาสต์ jookCast (YouTube Playlist)")
    .addStringOption((opt) =>
      opt.setName("url").setDescription("ลิงก์เพลง YouTube").setRequired(true),
    ),

  new SlashCommandBuilder()
    .setName("queue")
    .setDescription("ดูรายชื่อเพลงคิวปัจจุบันใน jookCast"),

  new SlashCommandBuilder()
    .setName("nowplaying")
    .setDescription("ดูเพลงที่กำลังเล่นหรือเพลงล่าสุดบนตู้คิว"),

  new SlashCommandBuilder()
    .setName("voteskip")
    .setDescription("ร่วมโหวตข้ามเพลงกร่อยที่อยู่หัวคิวปัจจุบัน"),

  new SlashCommandBuilder()
    .setName("lucky")
    .setDescription("ระบบสุ่มเพลงฮิตเข้าตู้ jookCast ดับเหงา"),

  new SlashCommandBuilder()
    .setName("setup_host")
    .setDescription("[Admin Only] ขอลิงก์ล็อกอินยืนยันสิทธิ์สำหรับ Host")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("submit_code")
    .setDescription("[Admin Only] ส่งรหัส Code ที่ได้จากการล็อกอิน")
    .addStringOption((opt) =>
      opt
        .setName("code_or_url")
        .setDescription("วาง URL หรือรหัส Code")
        .setRequired(true),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("set_playlist")
    .setDescription("[Admin Only] เปลี่ยนไอดี YouTube Playlist ปลายทาง")
    .addStringOption((opt) =>
      opt
        .setName("playlist_id")
        .setDescription("ใส่ YouTube Playlist ID")
        .setRequired(true),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("create_playlist")
    .setDescription("[Admin Only] สั่งสร้าง YouTube Playlist ใหม่เอี่ยม")
    .addStringOption((opt) =>
      opt
        .setName("name")
        .setDescription("ตั้งชื่อเพลย์ลิสต์")
        .setRequired(true),
    )
    .addStringOption((opt) =>
      opt
        .setName("privacy")
        .setDescription("ความเป็นส่วนตัว")
        .setRequired(false)
        .addChoices(
          { name: "Unlisted (ไม่สาธารณะ - แนะนำ)", value: "unlisted" },
          { name: "Public (สาธารณะ)", value: "public" },
          { name: "Private (ส่วนตัว)", value: "private" },
        ),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("remove")
    .setDescription("[Admin Only] ลบเพลงออกจากคิวตามลำดับตัวเลข")
    .addIntegerOption((opt) =>
      opt
        .setName("index")
        .setDescription("ลำดับเพลงในคำสั่ง /queue (เช่น 1, 2, 3)")
        .setRequired(true),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("clear_queue")
    .setDescription("[Admin Only] ล้างเพลงทั้งหมดในตู้ jookCast ให้โล่งเอี่ยม")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("jookcast_status")
    .setDescription("[Admin Only] ตรวจสอบสถิติและสถานะการเชื่อมต่อของระบบ")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
].map((cmd) => cmd.toJSON());

async function registerSlashCommands(clientId: string) {
  if (!DISCORD_TOKEN) return;
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  try {
    console.log("⏳ กำลังอัปเดตระบบคำสั่ง Slash Commands สำหรับ jookCast...");
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log("✅ อัปเดต Slash Commands ของ jookCast ทั้งหมดเรียบร้อย!");
  } catch (error) {
    console.error("❌ เกิดข้อผิดพลาดในการลงทะเบียนคำสั่ง:", error);
  }
}

client.once("ready", async () => {
  console.log(
    `🎙️ บอท jookCast พร้อมออนไลน์ทำงานแล้วในชื่อ: ${client.user?.tag}`,
  );
  if (client.user?.id) {
    await registerSlashCommands(client.user.id);
  }
});

// ─── HANDLERS ───────────────────────────────────────────────────────────────

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName } = interaction;

  // 🎵 /add
  if (commandName === "add") {
    const url = interaction.options.getString("url", true).trim();
    const videoId = extractVideoId(url);
    if (!videoId)
      return interaction.reply({
        content: "❌ ลิงก์ YouTube ไม่ถูกต้องครับ",
        ephemeral: true,
      });

    await interaction.deferReply();
    try {
      const snippet = await addSongToPlaylist(videoId);
      await interaction.editReply(
        `🎉 หยอดเพลงลงตู้คิว jookCast สำเร็จแล้ว!\n🎵 **ชื่อเพลง:** ${snippet?.title}`,
      );
    } catch (error: any) {
      await interaction.editReply(`❌ ล้มเหลว: ${error.message}`);
    }
  }

  // 📋 /queue
  if (commandName === "queue") {
    await interaction.deferReply();
    try {
      const songs = await getPlaylistSongs(10);
      if (songs.length === 0)
        return interaction.editReply(
          "📭 ตอนนี้ตู้เพลงว่างเปล่าจ้า ไม่มีเพลงในคิวเลย ใช้ `/add` มาหยอดสิ!",
        );

      let queueText = songs
        .map((song, index) => `${index + 1}. **${song.snippet?.title}**`)
        .join("\n");
      const embed = new EmbedBuilder()
        .setTitle("📋 คิวเพลงปัจจุบันใน jookCast")
        .setDescription(queueText)
        .setColor("#9b5de5")
        .setFooter({ text: `แสดงทั้งหมด ${songs.length} เพลงล่าสุด` });

      await interaction.editReply({ embeds: [embed] });
    } catch (error: any) {
      await interaction.editReply(`❌ เกิดข้อผิดพลาด: ${error.message}`);
    }
  }

  // 🎧 /nowplaying
  if (commandName === "nowplaying") {
    await interaction.deferReply();
    try {
      const songs = await getPlaylistSongs(1);
      if (songs.length === 0)
        return interaction.editReply(
          "🔇 ตอนนี้ไม่มีเพลงใดๆ กำลังออนแอร์อยู่ครับ",
        );

      const current = songs[0]?.snippet;
      const embed = new EmbedBuilder()
        .setTitle("📻 กำลังออนแอร์ / คิวถัดไป")
        .setDescription(
          `🎵 **${current?.title}**\n\n📺 ช่อง: *${current?.videoOwnerChannelTitle || "Unknown"}*`,
        )
        .setThumbnail(
          current?.thumbnails?.high?.url ||
            current?.thumbnails?.default?.url ||
            null,
        )
        .setColor("#00f5d4");

      await interaction.editReply({ embeds: [embed] });
    } catch (error: any) {
      await interaction.editReply(`❌ เกิดข้อผิดพลาด: ${error.message}`);
    }
  }

  // 🗳️ /voteskip
  if (commandName === "voteskip") {
    await interaction.deferReply();
    try {
      const songs = await getPlaylistSongs(1);
      if (songs.length === 0)
        return interaction.editReply("❌ ไม่มีเพลงให้ข้ามจ้า ตู้เพลงว่างอยู่");

      const userId = interaction.user.id;
      if (voteSkipUsers.has(userId)) {
        return interaction.editReply(
          `⚠️ คุณเคยโหวตข้ามเพลงนี้ไปแล้ว! (${voteSkipUsers.size}/${REQUIRED_VOTES})`,
        );
      }

      voteSkipUsers.add(userId);

      if (voteSkipUsers.size >= REQUIRED_VOTES) {
        await removeSongFromPlaylist(songs[0]?.id!);
        voteSkipUsers.clear(); // รีเซ็ตผลโหวตสำหรับเพลงถัดไป
        await interaction.editReply(
          `⏭️ **คะแนนเสียงครบถ้วน!** ดีดเพลงเก่าหัวคิวออกให้แล้ว หน้าจอจะแคสต์ไปเพลงถัดไปอัตโนมัติครับ!`,
        );
      } else {
        await interaction.editReply(
          `🗳️ มีคนอยากข้ามเพิ่มอีก 1 เสียง! (**${voteSkipUsers.size}/${REQUIRED_VOTES}** คนต้องการข้ามเพลงนี้)`,
        );
      }
    } catch (error: any) {
      await interaction.editReply(`❌ โหวตข้ามล้มเหลว: ${error.message}`);
    }
  }

  // 🎲 /lucky
  if (commandName === "lucky") {
    await interaction.deferReply();
    const funSongs = [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ", // Rickroll
      "https://www.youtube.com/watch?v=kJQP7kiw5Fk", // Despacito
      "https://www.youtube.com/watch?v=9bZkp7q19f0", // PSY - GANGNAM STYLE
    ];
    const randomSong = funSongs[Math.floor(Math.random() * funSongs.length)]!;
    const videoId = extractVideoId(randomSong);

    if (!videoId) {
      return interaction.editReply("❌ เกิดข้อผิดพลาดในระบบสุ่มลิงก์เพลง");
    }
    try {
      const snippet = await addSongToPlaylist(videoId);
      voteSkipUsers.clear(); // เพลงใหม่เข้า เคลียร์โหวตสคิปอันเก่า
      await interaction.editReply(
        `🎲 **ตู้เพลงสุ่มนำโชคระเบิด!** หยอดเพลงพิเศษเข้าตู้ให้แล้ว:\n🎵 **ชื่อเพลง:** ${snippet?.title}`,
      );
    } catch (error: any) {
      await interaction.editReply(`❌ สุ่มเพลงล้มเหลว: ${error.message}`);
    }
  }

  // ✂️ /remove [Admin]
  if (commandName === "remove") {
    await interaction.deferReply({ ephemeral: true });
    const index = interaction.options.getInteger("index", true);
    try {
      const songs = await getPlaylistSongs(20);
      if (index < 1 || index > songs.length)
        return interaction.editReply(
          `❌ ระบุลำดับไม่ถูกต้อง มีเพลงในคิวให้เลือกแค่ 1-${songs.length}`,
        );

      const targetSong = songs[index - 1];
      await removeSongFromPlaylist(targetSong?.id!);
      await interaction.editReply(
        `🗑️ ดีดเพลงลำดับที่ ${index}: **${targetSong?.snippet?.title}** ออกจากคิวเรียบร้อยครับ`,
      );
    } catch (error: any) {
      await interaction.editReply(`❌ ลบเพลงล้มเหลว: ${error.message}`);
    }
  }

  // 🧹 /clear_queue [Admin]
  if (commandName === "clear_queue") {
    await interaction.deferReply({ ephemeral: true });
    try {
      let songs = await getPlaylistSongs(50);
      if (songs.length === 0)
        return interaction.editReply("ตู้เพลงว่างสะอาดอยู่แล้วจ้า");

      while (songs.length > 0) {
        for (const song of songs) {
          await removeSongFromPlaylist(song.id!);
        }
        songs = await getPlaylistSongs(50); // ดึงเช็คเผื่อมีตกค้าง
      }
      voteSkipUsers.clear();
      await interaction.editReply(
        "🧹 **กวาดล้างตู้สำเร็จ!** เคลียร์เพลงทั้งหมดออกจาก Playlist เรียบร้อยแล้วครับ",
      );
    } catch (error: any) {
      await interaction.editReply(`❌ ล้างตู้ล้มเหลว: ${error.message}`);
    }
  }

  // 📊 /jookcast_status [Admin]
  if (commandName === "jookcast_status") {
    await interaction.deferReply({ ephemeral: true });
    const config = loadConfig();
    try {
      const youtube = getYouTubeClient();
      let totalSongs = 0;
      if (config.playlistId) {
        const res = await youtube.playlists.list({
          part: ["contentDetails"],
          id: [config.playlistId],
        });
        totalSongs = res.data.items?.[0]?.contentDetails?.itemCount || 0;
      }

      await interaction.editReply(
        `📊 **สถานะระบบ jookCast คลาวด์**\n🟢 บอทสแตนด์บาย: 24 ชั่วโมง\n📂 ไอดีตู้เพลง: \`${config.playlistId || "ยังไม่มี"}\`\n🎵 มีเพลงในตู้ทั้งหมด: \`${totalSongs}\` เพลง`,
      );
    } catch (error: any) {
      await interaction.editReply(`❌ ดึงสถานะล้มเหลว: ${error.message}`);
    }
  }

  // 🔑 ระบบ SETUP บัญชีพื้นฐาน (/setup_host, /submit_code, /set_playlist, /create_playlist เหมือนเดิม)
  if (commandName === "setup_host") {
    try {
      const oAuth2Client = getYouTubeOAuth2Client();
      const authUrl = oAuth2Client.generateAuthUrl({
        access_type: "offline",
        scope: SCOPES,
        prompt: "consent",
      });
      await interaction.reply({
        content: `🔑 **ขั้นตอนการตั้งค่า Host สำหรับ jookCast:**\n1. ล็อกอินสิทธิ์: [คลิกที่นี่](${authUrl})\n2. นำหน้าเว็บขาวมาส่งต่อด้วยคำสั่ง \`/submit_code\``,
        ephemeral: true,
      });
    } catch (error: any) {
      await interaction.reply({
        content: `❌ เกิดข้อผิดพลาด: ${error.message}`,
        ephemeral: true,
      });
    }
  }

  if (commandName === "submit_code") {
    await interaction.deferReply({ ephemeral: true });
    let input = interaction.options.getString("code_or_url", true).trim();
    let code = input.includes("code=")
      ? (new URL(input).searchParams.get("code") ?? input)
      : input;
    try {
      const oAuth2Client = getYouTubeOAuth2Client();
      const { tokens } = await oAuth2Client.getToken(code);
      fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2), "utf8");
      await interaction.editReply(
        "🎉 **สำเร็จ!** เชื่อมต่อบัญชีเข้ากับระบบ jookCast Host เรียบร้อยแล้วครับ!",
      );
    } catch (error: any) {
      await interaction.editReply(
        "❌ รหัสหมดอายุ กรุณากด `/setup_host` ใหม่ครับ",
      );
    }
  }

  if (commandName === "set_playlist") {
    const newPlaylistId = interaction.options
      .getString("playlist_id", true)
      .trim();
    const config = loadConfig();
    config.playlistId = newPlaylistId;
    saveConfig(config);
    await interaction.reply({
      content: `✅ เปลี่ยนตู้เพลง jookCast ไปที่ Playlist ID: \`${newPlaylistId}\` สำเร็จ!`,
      ephemeral: true,
    });
  }

  if (commandName === "create_playlist") {
    await interaction.deferReply({ ephemeral: true });
    const playlistName = interaction.options.getString("name", true).trim();
    const privacy = interaction.options.getString("privacy") ?? "unlisted";
    try {
      const generatedId = await createNewYouTubePlaylist(playlistName, privacy);
      if (!generatedId) throw new Error("ไม่ได้รับไอดีกลับมาจาก YouTube");
      const config = loadConfig();
      config.playlistId = generatedId;
      saveConfig(config);
      await interaction.editReply(
        `✨ **สร้างคิวเพลง jookCast ใหม่สำเร็จ!**\n📂 **ชื่อ:** \`${playlistName}\`\n🆔 **ID:** \`${generatedId}\`\n🔗 **ลิงก์คาสต์ขึ้นจอ:** https://www.youtube.com/playlist?list=${generatedId}`,
      );
    } catch (error: any) {
      await interaction.editReply(`❌ สร้างล้มเหลว: ${error.message}`);
    }
  }
});

// 🌐 หลอกสแกนพอร์ตของ Render กันโดนตัดสาย
const PORT = process.env.PORT ?? "10000";
http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("jookCast is running and casting music! 🎙️🎵");
  })
  .listen(PORT, () => {
    console.log(`🌐 สแตนด์บายพอร์ตจำลองที่ช่อง ${PORT}`);
  });

if (!DISCORD_TOKEN) console.error("❌ ไม่พบ DISCORD_TOKEN ใน .env");
else client.login(DISCORD_TOKEN);
