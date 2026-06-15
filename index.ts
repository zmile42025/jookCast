import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');
const TOKEN_PATH = path.join(__dirname, 'token.json');
const CONFIG_PATH = path.join(__dirname, 'config.json');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const SCOPES = ['https://www.googleapis.com/auth/youtube'];

// --- ระบบโหลด/บันทึกการตั้งค่า Playlist แบบ Realtime ---
interface BotConfig {
  playlistId: string | null;
}

function loadConfig(): BotConfig {
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch {
      return { playlistId: process.env.PLAYLIST_ID ?? null };
    }
  }
  return { playlistId: process.env.PLAYLIST_ID ?? null };
}

function saveConfig(config: BotConfig) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
}

// 1. ตั้งค่า Discord Bot Client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// 2. ฟังก์ชันโหลดสิทธิ์ YouTube OAuth2
function getYouTubeOAuth2Client() {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error('ไม่พบไฟล์ credentials.json ในเครื่อง กรุณาใส่ไฟล์ก่อนรันบอท');
  }
  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
  const { client_secret, client_id, redirect_uris } = credentials.installed;
  return new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
}

function getYouTubeClient() {
  if (!fs.existsSync(TOKEN_PATH)) {
    throw new Error('บอทยังไม่ได้ล็อกอินบัญชี YouTube Host กรุณาใช้คำสั่ง `/setup_host` บน Discord');
  }
  const oAuth2Client = getYouTubeOAuth2Client();
  const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
  oAuth2Client.setCredentials(token);
  return google.youtube({ version: 'v3', auth: oAuth2Client });
}

// 3. ฟังก์ชันสำหรับแกะเอา Video ID ออกจากลิงก์ YouTube
function extractVideoId(url: string): string | null {
  const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/;
  const match = url.match(regExp);
  const videoId = match?.[2];
  return (videoId && videoId.length === 11) ? videoId : null;
}

// 4. ฟังก์ชันยิง API ไปแอดเพลงเข้า Playlist บน YouTube
async function addSongToPlaylist(videoId: string) {
  const config = loadConfig();
  if (!config.playlistId) {
    throw new Error('ยังไม่ได้ตั้งค่าไอดี Playlist กรุณาใช้คำสั่ง `/set_playlist` หรือ `/create_playlist` ก่อน');
  }

  const youtube = getYouTubeClient();
  const response = await youtube.playlistItems.insert({
    part: ['snippet'],
    requestBody: {
      snippet: {
        playlistId: config.playlistId,
        resourceId: {
          kind: 'youtube#video',
          videoId: videoId,
        },
      },
    },
  });
  return response.data.snippet?.title;
}

// ==========================================
// ฟังก์ชันสั่ง YouTube ให้สร้าง Playlist ใหม่เอี่ยม
// ==========================================
async function createNewYouTubePlaylist(title: string, privacyStatus: string) {
  const youtube = getYouTubeClient();
  const response = await youtube.playlists.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: {
        title: title,
        description: 'เพลย์ลิสต์นี้สร้างอัตโนมัติโดย Discord jookCast Bot',
      },
      status: {
        privacyStatus: privacyStatus,
      },
    },
  });
  return response.data.id;
}

// ==========================================
// 5. ลงทะเบียนชุดคำสั่ง Slash Commands ทั้งหมด (อัปเดตชื่อ jookCast)
// ==========================================
const commands = [
  new SlashCommandBuilder()
    .setName('add')
    .setDescription('หยอดเพลงลงตู้คิวคาสต์ jookCast (YouTube Playlist)')
    .addStringOption(option =>
      option.setName('url')
        .setDescription('ลิงก์เพลง YouTube ที่ต้องการส่งเข้าคิว jookCast')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('setup_host')
    .setDescription('[Admin Only] ขอลิงก์ล็อกอินยืนยันสิทธิ์บัญชี YouTube สำหรับ Host ของ jookCast')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('submit_code')
    .setDescription('[Admin Only] ส่งรหัส Code หรือ URL ที่ได้หลังจากกดล็อกอินเข้าสู่ระบบ jookCast สำเร็จ')
    .addStringOption(option =>
      option.setName('code_or_url')
        .setDescription('วาง URL ทั้งดุ้น หรือเฉพาะตัวรหัส Code ที่ได้มา')
        .setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('set_playlist')
    .setDescription('[Admin Only] ตั้งค่าหรือเปลี่ยนไอดี YouTube Playlist ปลายทางของ jookCast')
    .addStringOption(option =>
      option.setName('playlist_id')
        .setDescription('ใส่ YouTube Playlist ID (เช่น PLxxxxxxxx...)')
        .setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('create_playlist')
    .setDescription('[Admin Only] สั่ง jookCast สร้าง YouTube Playlist ใหม่เอี่ยมให้ทันที')
    .addStringOption(option =>
      option.setName('name')
        .setDescription('ตั้งชื่อเพลย์ลิสต์ที่คุณต้องการ (เช่น คลังเพลง jookCast คืนนี้)')
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName('privacy')
        .setDescription('ตั้งค่าความเป็นส่วนตัว (แนะนำ unlisted คนมีลิงก์ถึงจะเห็น)')
        .setRequired(false)
        .addChoices(
          { name: 'Unlisted (ไม่เป็นสาธารณะ - แนะนำ)', value: 'unlisted' },
          { name: 'Public (สาธารณะใครก็ค้นเจอ)', value: 'public' },
          { name: 'Private (ส่วนตัวเห็นคนเดียว)', value: 'private' }
        )
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
].map(command => command.toJSON());

async function registerSlashCommands(clientId: string) {
  if (!DISCORD_TOKEN) return;
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

  try {
    console.log('⏳ กำลังอัปเดตระบบคำสั่ง Slash Commands สำหรับ jookCast...');
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log('✅ อัปเดต Slash Commands ของ jookCast ทั้งหมดเรียบร้อย!');
  } catch (error) {
    console.error('❌ เกิดข้อผิดพลาดในการลงทะเบียนคำสั่ง:', error);
  }
}

client.once('ready', async () => {
  console.log(`🎙️ บอท jookCast พร้อมออนไลน์ทำงานแล้วในชื่อ: ${client.user?.tag}`);
  if (client.user?.id) {
    await registerSlashCommands(client.user.id);
  }
});

// ==========================================
// 7. จัดการคำสั่งต่างๆ (Interactions)
// ==========================================
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  // 🎵 คำสั่ง /add
  if (commandName === 'add') {
    const url = interaction.options.getString('url', true).trim();
    const videoId = extractVideoId(url);

    if (!videoId) {
      await interaction.reply({ content: '❌ รูปแบบลิงก์ YouTube ไม่ถูกต้องครับ', ephemeral: true });
      return;
    }

    await interaction.deferReply();

    try {
      const songTitle = await addSongToPlaylist(videoId);
      await interaction.editReply(`🎉 หยอดเพลงลงตู้คิว jookCast สำเร็จแล้ว!\n🎵 **ชื่อเพลง:** ${songTitle}`);
    } catch (error: any) {
      console.error(error);
      await interaction.editReply(`❌ ล้มเหลว: ${error.message || 'เกิดข้อผิดพลาดในการคาสต์เพลง'}`);
    }
  }

  // 🔐 คำสั่ง /setup_host
  if (commandName === 'setup_host') {
    try {
      const oAuth2Client = getYouTubeOAuth2Client();
      const authUrl = oAuth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: SCOPES,
        prompt: 'consent'
      });

      await interaction.reply({
        content: `🔑 **ขั้นตอนการตั้งค่าบัญชี Host สำหรับ jookCast:**\n1. คลิกเข้าไปที่ลิงก์นี้เพื่อล็อกอินบัญชียูทูปของคุณ: [คลิกเพื่อล็อกอินสิทธิ์](${authUrl})\n2. เมื่อกดยอมรับแล้ว หน้าเว็บจะเด้งไปที่หน้าขาวๆ (localhost)\n3. ก๊อปปี้ URL บนเบราว์เซอร์ทั้งหมดมา แล้วใช้คำสั่ง \`/submit_code\` ในดิสคอร์ดเพื่อส่งรหัสเข้าสู่ระบบครับ!`,
        ephemeral: true
      });
    } catch (error: any) {
      await interaction.reply({ content: `❌ เกิดข้อผิดพลาด: ${error.message}`, ephemeral: true });
    }
  }

  // 📥 คำสั่ง /submit_code
  if (commandName === 'submit_code') {
    await interaction.deferReply({ ephemeral: true });
    let input = interaction.options.getString('code_or_url', true).trim();
    
    let code = input;
    if (input.includes('code=')) {
      const urlObj = new URL(input);
      code = urlObj.searchParams.get('code') ?? input;
    }

    try {
      const oAuth2Client = getYouTubeOAuth2Client();
      const { tokens } = await oAuth2Client.getToken(code);
      oAuth2Client.setCredentials(tokens);
      
      fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2), 'utf8');
      await interaction.editReply('🎉 **สำเร็จ!** เชื่อมต่อบัญชีเข้ากับระบบ jookCast Host เรียบร้อยแล้วครับ!');
    } catch (error: any) {
      console.error(error);
      await interaction.editReply('❌ รหัสยืนยันสิทธิ์ไม่ถูกต้อง หรือหมดอายุ กรุณากด `/setup_host` ใหม่ครับ');
    }
  }

  // 📂 คำสั่ง /set_playlist
  if (commandName === 'set_playlist') {
    const newPlaylistId = interaction.options.getString('playlist_id', true).trim();
    const config = loadConfig();
    config.playlistId = newPlaylistId;
    saveConfig(config);

    await interaction.reply({ content: `✅ เปลี่ยนตู้เพลง jookCast ไปที่ Playlist ID: \`${newPlaylistId}\` สำเร็จแล้ว!`, ephemeral: true });
  }

  // 🛠️ คำสั่ง /create_playlist
  if (commandName === 'create_playlist') {
    await interaction.deferReply({ ephemeral: true });
    const playlistName = interaction.options.getString('name', true).trim();
    const privacy = interaction.options.getString('privacy') ?? 'unlisted';

    try {
      const generatedId = await createNewYouTubePlaylist(playlistName, privacy);
      
      if (!generatedId) throw new Error('ไม่ได้รับไอดีเพลย์ลิสต์กลับมาจาก YouTube');

      const config = loadConfig();
      config.playlistId = generatedId;
      saveConfig(config);

      await interaction.editReply(`✨ **สร้างคิวเพลง jookCast ใหม่สำเร็จเสร็จสรรพ!**\n📂 **ชื่อเพลย์ลิสต์:** \`${playlistName}\`\n🆔 **Playlist ID:** \`${generatedId}\`\n🔗 **ลิงก์เปิดบนทีวี/แท็บเล็ต:** https://www.youtube.com/playlist?list=${generatedId}\n\n*ระบบสลับตู้เพลงหลักมาใช้ตัวนี้ให้คุณอัตโนมัติแล้ว เริ่มรัน jookCast ได้ทันทีครับ!*`);
    } catch (error: any) {
      console.error(error);
      await interaction.editReply(`❌ สร้างเพลย์ลิสต์ jookCast ล้มเหลว: ${error.response?.data?.error?.message || error.message}`);
    }
  }
});

if (!DISCORD_TOKEN) {
  console.error('❌ ไม่พบ DISCORD_TOKEN ในไฟล์ .env');
} else {
  client.login(DISCORD_TOKEN);
}