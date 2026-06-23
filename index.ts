import { 
  Client, 
  GatewayIntentBits, 
  REST, 
  Routes, 
  SlashCommandBuilder, 
  PermissionFlagsBits, 
  EmbedBuilder, 
  ActionRowBuilder, 
  StringSelectMenuBuilder, 
  StringSelectMenuOptionBuilder,
  TextChannel,
  Guild
} from 'discord.js';
import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import http from 'http';
import urlModule from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');
const TOKEN_PATH = path.join(__dirname, 'token.json');
const CONFIG_PATH = path.join(__dirname, 'config.json');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const SCOPES = ['https://www.googleapis.com/auth/youtube'];

// 🎵 ไอดีวิดีโอสำหรับใช้เป็นเพลงเปิดสถานีสแตนด์บายบนแท็บเล็ต
const INTRO_VIDEO_ID = 'kJQP7kiw5Fk'; 

const BOT_VERSION = 'v2.7.5';
const RELEASE_NOTES = `✨ **มีอะไรใหม่ในเวอร์ชัน ${BOT_VERSION}**\n- 🤝 **Auto-Setup on Join:** เพิ่มระบบตื่นตัวอัจฉริยะ ทันทีที่บอทถูกเชิญเข้าเซิร์ฟเวอร์ใหม่ จะทำการสร้างช่อง \`#jookcast-status\` และ \`#jookcast-feed\` พร้อมยิงคู่มือการใช้งานให้ทันทีอัตโนมัติหน้างานโดยไม่ต้องรีสตาร์ทบอทหลังบ้านครับ!`;

let voteSkipUsers = new Set<string>();
const REQUIRED_VOTES = 3;

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

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

function getYouTubeOAuth2Client() {
  // 1. ตรวจสอบว่าพี่ใส่ค่าไว้ใน Environment Variables ของ Render หรือไม่
  if (process.env.YOUTUBE_CLIENT_ID && process.env.YOUTUBE_CLIENT_SECRET) {
    const clientId = process.env.YOUTUBE_CLIENT_ID;
    const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
    const redirectUri = process.env.RENDER_EXTERNAL_URL 
      ? `${process.env.RENDER_EXTERNAL_URL}/api/callback` 
      : (process.env.YOUTUBE_REDIRECT_URI ?? 'http://localhost:10000/api/callback');

    return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  }

  // 2. อ่านจากไฟล์ credentials.json (รองรับทั้ง Web App และ Desktop App)
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error('ไม่พบข้อมูลแอปใน Environment และไม่พบไฟล์ credentials.json กรุณาตั้งค่าก่อนใช้งาน');
  }
  
  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
  
  // ✨ จุดแก้ตายตัว: ถ้าดึงจาก Web app ให้ใช้ credentials.web ถ้าดึงจาก Desktop ให้ใช้ credentials.installed
  const target = credentials.web || credentials.installed;
  
  if (!target) {
    throw new Error('โครงสร้างไฟล์ credentials.json ไม่ถูกต้อง ไม่พบหัวข้อ web หรือ installed');
  }
  
  // ดึง Redirect URI ตัวแรกจากในไฟล์มาใช้
  const redirectUri = target.redirect_uris?.[0] ?? 'http://localhost:10000/api/callback';
  
  return new google.auth.OAuth2(target.client_id, target.client_secret, redirectUri);
}

function getYouTubeClient() {
  if (!fs.existsSync(TOKEN_PATH)) {
    throw new Error('บอทยังไม่ได้ล็อกอินบัญชี YouTube Host กรุณาใช้คำสั่ง \`/setup_host\` เพื่อผูกบัญชีผ่านหน้าเว็บ');
  }
  const oAuth2Client = getYouTubeOAuth2Client();
  const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
  oAuth2Client.setCredentials(token);
  return google.youtube({ version: 'v3', auth: oAuth2Client });
}

function extractVideoId(url: string): string | null {
  const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/;
  const match = url.match(regExp);
  const videoId = match?.[2];
  return (videoId && videoId.length === 11) ? videoId : null;
}

// ─── YOUTUBE API FUNCTIONS ──────────────────────────────────────────────────

async function addSongToPlaylist(videoId: string) {
  const config = loadConfig();
  if (!config.playlistId) throw new Error('ยังไม่ได้ตั้งค่าไอดี Playlist ปลายทาง');
  const youtube = getYouTubeClient();
  const response = await youtube.playlistItems.insert({
    part: ['snippet'],
    requestBody: {
      snippet: {
        playlistId: config.playlistId,
        resourceId: { kind: 'youtube#video', videoId: videoId },
      },
    },
  });
  return response.data.snippet;
}

async function createNewYouTubePlaylist(title: string, privacyStatus: string) {
  const youtube = getYouTubeClient();
  const response = await youtube.playlists.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: {
        title: title,
        description: 'เพลย์ลิสต์นี้สร้างอัตโนมัติโดย Discord jookCast Bot',
      },
      status: { privacyStatus: privacyStatus },
    },
  });
  return response.data.id;
}

async function getPlaylistSongs(maxResults = 10) {
  const config = loadConfig();
  if (!config.playlistId) throw new Error('ยังไม่ได้ตั้งค่าไอดี Playlist');
  const youtube = getYouTubeClient();
  const response = await youtube.playlistItems.list({
    part: ['snippet', 'id'],
    playlistId: config.playlistId,
    maxResults: maxResults,
  });
  return response.data.items || [];
}

async function removeSongFromPlaylist(playlistItemId: string) {
  const youtube = getYouTubeClient();
  await youtube.playlistItems.delete({ id: playlistItemId });
}

async function searchYouTubeFiveVideos(keyword: string) {
  const youtube = getYouTubeClient();
  const response = await youtube.search.list({
    part: ['snippet'],
    q: keyword,
    maxResults: 5,
    type: ['video']
  });
  return response.data.items || [];
}

async function checkAndAutoFillQueue(): Promise<string[]> {
  try {
    const currentSongs = await getPlaylistSongs(5);
    if (currentSongs.length <= 1) {
      const youtube = getYouTubeClient();
      const trendingResponse = await youtube.videos.list({
        part: ['snippet'],
        chart: 'mostPopular',
        regionCode: 'TH',
        videoCategoryId: '10',
        maxResults: 10
      });

      const trendingVideos = trendingResponse.data.items || [];
      if (trendingVideos.length === 0) return [];

      const shuffled = trendingVideos.sort(() => 0.5 - Math.random());
      const selectedVideos = shuffled.slice(0, 3);
      const addedTitles: string[] = [];

      for (const video of selectedVideos) {
        if (video.id) {
          const snippet = await addSongToPlaylist(video.id);
          if (snippet?.title) addedTitles.push(snippet.title);
        }
      }
      return addedTitles;
    }
  } catch (error) {
    console.error('⚠️ Auto-Fill Error:', error);
  }
  return [];
}

// ─── ระบบฟังก์ชันตั้งค่าช่องสัญญาณ (สร้างโมดูลย่อยให้เรียกซ้ำแยกตามกิลด์ได้) ───

async function setupSingleGuildChannels(guild: Guild) {
  const STATUS_CHANNEL = 'jookcast-status';
  const FEED_CHANNEL = 'jookcast-feed';

  try {
    let statusChan = guild.channels.cache.find(ch => ch.name === STATUS_CHANNEL && ch.isTextBased()) as TextChannel;
    if (!statusChan) {
      statusChan = await guild.channels.create({
        name: STATUS_CHANNEL,
        permissionOverwrites: [{ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.SendMessages], allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] }]
      });
    }

    let feedChan = guild.channels.cache.find(ch => ch.name === FEED_CHANNEL && ch.isTextBased()) as TextChannel;
    if (!feedChan) {
      await guild.channels.create({
        name: FEED_CHANNEL,
        reason: 'ช่องสำหรับเก็บประวัติล็อกตู้เพลงแบบปิดเสียงแจ้งเตือน',
        permissionOverwrites: [{ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.SendMessages], allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] }]
      });
    }

    const messages = await statusChan.messages.fetch({ limit: 10 });
    const hasWelcomeMessage = messages.some(msg => msg.embeds.some(emb => emb.title?.includes('คู่มือการใช้งาน')));
    
    if (!hasWelcomeMessage) {
      const welcomeEmbed = new EmbedBuilder()
        .setTitle('🎙️ ตู้เพลงคลาวด์ jookCast - คู่มือการใช้งาน')
        .setDescription('ระบบฝากส่งเพลงจาก Discord ไปเล่นบนหน้าจอหลักผ่านคลัง YouTube Playlist แบบเรียลไทม์!')
        .setColor('#00f5d4')
        .addFields(
          { name: '🔍 ค้นหาเพลงอย่างเซียน', value: '`/search [ชื่อเพลง/ศิลปิน]` บอทจะแสดงเมนูให้เลือกเพลง (เห็นแค่คุณคนเดียว แชทไม่รก)', inline: false },
          { name: '🔗 หยอดเพลงตรงด้วยลิงก์', value: '`/add [ลิงก์ YouTube]` แอดเข้าคิวตู้เพลงหลักทันที', inline: false },
          { name: '📋 ตรวจสอบคิวเพลง', value: '`/queue` เช็คดูรายชื่อ 10 เพลงถัดไปในตู้', inline: true },
          { name: '📻 ดูเพลงปัจจุบัน', value: '`/nowplaying` ดูเพลงที่กำลังออนแอร์', inline: true },
          { name: '🗳️ โหวตข้ามเพลงกร่อย', value: '`/voteskip` ร่วมใจกันกดครบ 3 คน ดีดเพลงหัวคิวทิ้งทันที!', inline: false }
        )
        .setFooter({ text: 'jookCast Station' });
      
      await statusChan.send({ embeds: [welcomeEmbed] });
    }

    const isAlreadyNotified = messages.some(msg => msg.embeds.some(emb => emb.title?.includes(BOT_VERSION)));
    if (!isAlreadyNotified) {
      const updateEmbed = new EmbedBuilder()
        .setTitle(`🚀 บอท jookCast อัปเกรดระบบเป็นเวอร์ชัน ${BOT_VERSION}!`)
        .setDescription(RELEASE_NOTES)
        .setColor('#9b5de5')
        .setTimestamp();
      
      await statusChan.send({ embeds: [updateEmbed] });
    }

    console.log(`✅ ตั้งค่าระบบช่องสัญญาณเรียบร้อยสำหรับกิลด์: ${guild.name}`);
  } catch (err) {
    console.error(`⚠️ ไม่สามารถตั้งค่าแชนเนลระบบในกิลด์ ${guild.name} ได้ (อาจจะขาดสิทธิ์การจัดการแชนเนล)`);
  }
}

async function setupAllGuildsChannels(client: Client) {
  for (const guild of client.guilds.cache.values()) {
    await setupSingleGuildChannels(guild);
  }
}

// ─── COMMANDS REGISTER ──────────────────────────────────────────────────────

const commands = [
  new SlashCommandBuilder().setName('add').setDescription('หยอดเพลงด้วยลิงก์ลงตู้คิว jookCast (ข้อความจะไปแจ้งเตือนเงียบๆ ที่ช่องฟีด)')
    .addStringOption(opt => opt.setName('url').setDescription('ลิงก์เพลง YouTube').setRequired(true)),
  
  new SlashCommandBuilder().setName('search').setDescription('ค้นหาเพลงแล้วกดเลือกเข้าตู้คิว jookCast (เห็นเฉพาะคุณ)')
    .addStringOption(opt => opt.setName('keyword').setDescription('พิมพ์ชื่อเพลง หรือชื่อศิลปิน').setRequired(true)),

  new SlashCommandBuilder().setName('queue').setDescription('ดูรายชื่อเพลงคิวปัจจุบันใน jookCast'),
  new SlashCommandBuilder().setName('nowplaying').setDescription('ดูเพลงที่กำลังออนแอร์ / คิวล่าสุด'),
  new SlashCommandBuilder().setName('voteskip').setDescription('ร่วมโหวตข้ามเพลงกร่อยที่อยู่หัวคิวปัจจุบัน'),
  
  new SlashCommandBuilder().setName('setup_host').setDescription('[Admin Only] ขอลิงก์ล็อกอินยืนยันสิทธิ์สำหรับ Host และซิงค์ออโต้')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder().setName('set_playlist').setDescription('[Admin Only] เปลี่ยนไอดี YouTube Playlist ปลายทาง')
    .addStringOption(opt => opt.setName('playlist_id').setDescription('ใส่ YouTube Playlist ID').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder().setName('create_playlist').setDescription('[Admin Only] สั่งสร้าง YouTube Playlist ใหม่เอี่ยมพร้อมฝังเพลง Intro')
    .addStringOption(opt => opt.setName('name').setDescription('ตั้งชื่อเพลย์ลิสต์').setRequired(true))
    .addStringOption(opt => opt.setName('privacy').setDescription('ความเป็นส่วนตัว').setRequired(false)
      .addChoices(
        { name: 'Unlisted (ไม่สาธารณะ - แนะนำ)', value: 'unlisted' },
        { name: 'Public (สาธารณะ)', value: 'public' },
        { name: 'Private (ส่วนตัว)', value: 'private' },
      ))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder().setName('remove').setDescription('[Admin Only] ลบเพลงออกจากคิวตามลำดับตัวเลข')
    .addIntegerOption(opt => opt.setName('index').setDescription('ลำดับเพลงในคิว').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    
  new SlashCommandBuilder().setName('clear_queue').setDescription('[Admin Only] ล้างเพลงทั้งหมดในตู้ jookCast ให้โล่งเอี่ยม')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder().setName('jookcast_status').setDescription('[Admin Only] ตรวจสอบสถิติและสถานะการเชื่อมต่อของระบบ')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
].map(cmd => cmd.toJSON());

// ─── DISCORD CLIENT EVENTS ──────────────────────────────────────────────────

client.once('ready', async () => {
  console.log(`🎙️ บอท jookCast ${BOT_VERSION} พร้อมใช้งานแล้ว!`);
  if (client.user?.id) {
    try {
      const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN!);
      await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
      console.log('✅ ลงทะเบียนคำสั่ง Slash Commands ใหม่เรียบร้อย');
      
      // กวาดตรวจสอบทุกเซิร์ฟเวอร์ที่บอทอาศัยอยู่ ณ ตอนเปิดเครื่อง
      await setupAllGuildsChannels(client);
    } catch (err) {
      console.error('❌ ข้อผิดพลาดในขั้นตอนเปิดระบบแรดดี้:', err);
    }
  }
});

// 🔥 [✨ ฟีเจอร์ใหม่] ทำงานทันทีเมื่อมีคนเชิญบอทเข้าเซิร์ฟเวอร์ใหม่หน้างานโดยไม่ต้องรีสตาร์ทบอท
client.on('guildCreate', async (guild) => {
  console.log(`📥 บอทถูกเชิญเข้าเซิร์ฟเวอร์ใหม่: ${guild.name} (ID: ${guild.id})`);
  await setupSingleGuildChannels(guild);
});

// ─── INTERACTION HANDLERS ───────────────────────────────────────────────────

client.on('interactionCreate', async (interaction) => {
  if (interaction.isChatInputCommand()) {
    const { commandName } = interaction;

    if (commandName === 'search') {
      const keyword = interaction.options.getString('keyword', true).trim();
      await interaction.deferReply({ ephemeral: true });

      try {
        const videos = await searchYouTubeFiveVideos(keyword);
        if (videos.length === 0) return interaction.editReply(`❌ ไม่พบผลลัพธ์สำหรับคำว่า: \`${keyword}\``);

        const selectMenu = new StringSelectMenuBuilder()
          .setCustomId('search-select')
          .setPlaceholder('🎵 เลือกเพลงที่ต้องการหยอดเข้าตู้ได้เลยครับ...');

        videos.forEach((video) => {
          const vId = video.id?.videoId;
          const title = video.snippet?.title || 'Unknown Title';
          const channel = video.snippet?.channelTitle || 'Unknown Channel';
          
          if (vId) {
            selectMenu.addOptions(
              new StringSelectMenuOptionBuilder()
                .setLabel(title.slice(0, 95))
                .setDescription(`ช่อง: ${channel.slice(0, 50)}`)
                .setValue(vId)
            );
          }
        });

        const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);
        await interaction.editReply({
          content: `🔍 **ผลลัพธ์การค้นหาสำหรับ:** \`${keyword}\`\n*(ข้อความเมนูนี้เห็นแค่คุณคนเดียว เลือกเสร็จแล้วระบบจะไปบันทึกเงียบๆ ที่ช่องฟีดครับ)*`,
          components: [row]
        });
      } catch (error: any) { 
        await interaction.editReply(`❌ ค้นหาล้มเหลว: ${error.message}`); 
      }
    }

    if (commandName === 'add') {
      const url = interaction.options.getString('url', true).trim();
      const videoId = extractVideoId(url);
      if (!videoId) return interaction.reply({ content: '❌ ลิงก์ YouTube ไม่ถูกต้องครับ', ephemeral: true });
      
      await interaction.reply({ content: '⏳ กำลังส่งเพลงเข้าตู้คิวหลักให้ครับ...', ephemeral: true });

      try {
        const snippet = await addSongToPlaylist(videoId);
        let logMessage = `📥 **<@${interaction.user.id}>** ได้หยอดเพลงเข้าตู้หลักผ่านลิงก์:\n🎵 **ชื่อเพลง:** ${snippet?.title}\n🔗 ลิงก์: https://youtu.be/${videoId}`;
        
        voteSkipUsers.clear();
        const autoFilled = await checkAndAutoFillQueue();
        if (autoFilled.length > 0) logMessage += `\n🤖 *[Auto-Fill]* คิวเพลงเหลือน้อย บอทช่วยเติมเพลงฮิตพ่วงท้ายให้เรียบร้อยครับ`;

        const feedChannel = interaction.guild?.channels.cache.find(ch => ch.name === 'jookcast-feed' && ch.isTextBased()) as TextChannel;
        if (feedChannel) {
          await feedChannel.send({ content: logMessage, flags: [4096] });
        }
      } catch (error: any) { 
        console.error('❌ การแอดเพลงด้วยลิงก์ผิดพลาด:', error); 
      }
    }

    if (commandName === 'queue') {
      await interaction.deferReply();
      try {
        const autoFilled = await checkAndAutoFillQueue();
        const songs = await getPlaylistSongs(10);
        if (songs.length === 0) return interaction.editReply('📭 ตู้เพลงว่างเปล่าจ้า พิมพ์ \`/search\` มาเปิดเพลงสิ!');
        
        let text = songs.map((s, i) => `${i + 1}. **${s.snippet?.title}**`).join('\n');
        if (autoFilled.length > 0) text += `\n\n🤖 *[Auto-Fill]* เพลงคิวใกล้หมด เติมเทรนด์ติดอันดับ TH เพิ่มให้เรียบร้อย`;
        
        const embed = new EmbedBuilder()
          .setTitle('📋 คิวเพลงปัจจุบันใน jookCast')
          .setDescription(text)
          .setColor('#9b5de5')
          .setFooter({ text: `แสดงทั้งหมด ${songs.length} เพลงล่าสุด` });
          
        await interaction.editReply({ embeds: [embed] });
      } catch (e: any) { 
        await interaction.editReply(`❌ ผิดพลาด: ${e.message}`); 
      }
    }

    if (commandName === 'nowplaying') {
      await interaction.deferReply();
      try {
        const songs = await getPlaylistSongs(1);
        if (songs.length === 0) return interaction.editReply('🔇 ไม่มีเพลงออนแอร์อยู่ครับ');
        const cur = songs[0]?.snippet;
        const embed = new EmbedBuilder()
          .setTitle('📻 กำลังออนแอร์ / คิวถัดไป')
          .setDescription(`🎵 **${cur?.title}**\n\n📺 ช่อง: *${cur?.videoOwnerChannelTitle || "Unknown"}*`)
          .setThumbnail(cur?.thumbnails?.high?.url || cur?.thumbnails?.default?.url || null)
          .setColor('#00f5d4');
        await interaction.editReply({ embeds: [embed] });
      } catch (e: any) { 
        await interaction.editReply(`❌ ผิดพลาด: ${e.message}`); 
      }
    }

    if (commandName === 'voteskip') {
      await interaction.deferReply();
      try {
        const songs = await getPlaylistSongs(1);
        if (songs.length === 0) return interaction.editReply('❌ ไม่มีเพลงให้ข้ามจ้า');
        const uId = interaction.user.id;
        
        if (voteSkipUsers.has(uId)) return interaction.editReply(`⚠️ คุณเคยโหวตเพลงนี้ไปแล้ว (${voteSkipUsers.size}/${REQUIRED_VOTES})`);
        voteSkipUsers.add(uId);
        
        if (voteSkipUsers.size >= REQUIRED_VOTES) {
          await removeSongFromPlaylist(songs[0]?.id!);
          voteSkipUsers.clear();
          await checkAndAutoFillQueue();
          await interaction.editReply(`⏭️ **คะแนนเสียงครบ!** ข้ามเพลงเก่าให้เรียบร้อยแล้วจ้า!`);
        } else {
          await interaction.editReply(`🗳️ ต้องการคนโหวตเพิ่ม! (**${voteSkipUsers.size}/${REQUIRED_VOTES}**)`);
        }
      } catch (e: any) { 
        await interaction.editReply(`❌ โหวตล้มเหลว: ${e.message}`); 
      }
    }

    if (commandName === 'remove') {
      await interaction.deferReply({ ephemeral: true });
      const idx = interaction.options.getInteger('index', true);
      try {
        const songs = await getPlaylistSongs(20);
        if (idx < 1 || idx > songs.length) return interaction.editReply(`❌ ลำดับไม่ถูกต้อง มีเพลงในคิวให้เลือกแค่ 1-${songs.length}`);
        
        const targetSong = songs[idx - 1];
        await removeSongFromPlaylist(targetSong?.id!);
        await interaction.editReply(`🗑️ ดีดเพลงลำดับที่ ${idx}: **${targetSong?.snippet?.title}** ออกจากคิวเรียบร้อยครับ`);
      } catch (e: any) { 
        await interaction.editReply(`❌ ลบเพลงล้มเหลว: ${e.message}`); 
      }
    }

    if (commandName === 'clear_queue') {
      await interaction.deferReply({ ephemeral: true });
      try {
        let songs = await getPlaylistSongs(50);
        if (songs.length === 0) return interaction.editReply('ตู้เพลงว่างสะอาดอยู่แล้วจ้า');
        while (songs.length > 0) {
          for (const s of songs) { await removeSongFromPlaylist(s.id!); }
          songs = await getPlaylistSongs(50);
        }
        voteSkipUsers.clear();
        await interaction.editReply('🧹 **กวาดล้างตู้สำเร็จ!** เคลียร์เพลงทั้งหมดออกจาก Playlist เรียบร้อยแล้วครับ');
      } catch (e: any) { 
        await interaction.editReply(`❌ ล้มเหลว: ${e.message}`); 
      }
    }

    if (commandName === 'jookcast_status') {
      await interaction.deferReply({ ephemeral: true });
      const config = loadConfig();
      try {
        const youtube = getYouTubeClient();
        let totalSongs = 0;
        if (config.playlistId) {
          const res = await youtube.playlists.list({ part: ['contentDetails'], id: [config.playlistId] });
          totalSongs = res.data.items?.[0]?.contentDetails?.itemCount || 0;
        }
        await interaction.editReply(`📊 **สถานะระบบ jookCast คลาวด์**\n🟢 บอทสแตนด์บาย: 24 ชั่วโมง\n📂 ไอดีตู้เพลง: \`${config.playlistId || "ยังไม่มี"}\`\n🎵 มีเพลงในตู้ทั้งหมด: \`${totalSongs}\` เพลง`);
      } catch (error: any) { 
        await interaction.editReply(`❌ ดึงสถานะล้มเหลว: ${error.message}`); 
      }
    }

    if (commandName === 'setup_host') {
      try {
        const oAuth2Client = getYouTubeOAuth2Client();
        const authUrl = oAuth2Client.generateAuthUrl({ access_type: 'offline', scope: SCOPES, prompt: 'consent' });
        await interaction.reply({ content: `🔑 **ระบบผูกสิทธิ์บัญชี Host ตู้เพลงอัตโนมัติ:**\n1. ล็อกอินสิทธิ์โดย: [คลิกเชื่อมต่อที่นี่](${authUrl})\n2. หลังจากกดอนุญาตเสร็จ หน้าเว็บหลังบ้านจะซิงค์ข้อมูลบันทึกรหัสล็อกอินให้เองทันทีโดยที่พี่ไม่ต้องเอารหัสมาก๊อปวางแล้วครับ!`, ephemeral: true });
      } catch (error: any) { 
        await interaction.reply({ content: `❌ เกิดข้อผิดพลาด: ${error.message}`, ephemeral: true }); 
      }
    }

    if (commandName === 'set_playlist') {
      const newPlaylistId = interaction.options.getString('playlist_id', true).trim();
      const config = loadConfig();
      config.playlistId = newPlaylistId;
      saveConfig(config);
      await interaction.reply({ content: `✅ เปลี่ยนตู้เพลง jookCast ไปที่ Playlist ID: \`${newPlaylistId}\` สำเร็จ!`, ephemeral: true });
    }

    if (commandName === 'create_playlist') {
      await interaction.deferReply({ ephemeral: true });
      const playlistName = interaction.options.getString('name', true).trim();
      const privacy = interaction.options.getString('privacy') ?? 'unlisted';
      try {
        const generatedId = await createNewYouTubePlaylist(playlistName, privacy);
        if (!generatedId) throw new Error('ไม่ได้รับไอดีกลับมาจาก YouTube');
        
        const config = loadConfig();
        config.playlistId = generatedId;
        saveConfig(config);

        let embedStatus = '';
        try {
          const introSnippet = await addSongToPlaylist(INTRO_VIDEO_ID);
          embedStatus = `\n📻 บอทได้ฝังเพลงเริ่มต้นให้แล้ว: **"${introSnippet?.title}"** พี่สามารถนำลิงก์ด้านล่างไปกด Play เปิดทิ้งไว้บนแท็บเล็ตได้เลยครับ!`;
        } catch (introErr) {
          console.error('⚠️ ไม่สามารถใส่เพลงเปิดสถานีอัตโนมัติได้ แต่องค์ประกอบเพลย์ลิสต์สร้างสำเร็จ:', introErr);
          embedStatus = `\n⚠️ *[Auto-Embed ล้มเหลว]* สร้างเพลย์ลิสต์ได้ แต่ระบบไม่สามารถใส่เพลง Intro เริ่มต้นให้ได้เนื่องจากสิทธิ์ติดขัด`;
        }

        await interaction.editReply(`✨ **สร้างคิวเพลง jookCast ใหม่สำเร็จ!**\n📂 **ชื่อ:** \`${playlistName}\`${embedStatus}\n🆔 **ID:** \`${generatedId}\`\n🔗 **ลิงก์คาสต์ขึ้นจอแท็บเล็ต:** https://www.youtube.com/playlist?list=${generatedId}`);
      } catch (error: any) { 
        await interaction.editReply(`❌ สร้างล้มเหลว: ${error.message}`); 
      }
    }
  }

  if (interaction.isStringSelectMenu()) {
    if (interaction.customId === 'search-select') {
      const selectedVideoId = interaction.values?.[0];
      if (!selectedVideoId) return interaction.reply({ content: '❌ ผิดพลาดในการดึงข้อมูลคิวเพลง', ephemeral: true });

      await interaction.reply({ content: '✅ เพิ่มเพลงเข้าสู่คลังหลักเรียบร้อยแล้ว!', ephemeral: true });

      try {
        const snippet = await addSongToPlaylist(selectedVideoId);
        let logMessage = `🎶 **<@${interaction.user.id}>** ได้เลือกเพลงหยอดเข้าตู้เรียบร้อย!\n🎵 **ชื่อเพลง:** ${snippet?.title}\n🔗 ลิงก์: https://youtu.be/${selectedVideoId}`;
        
        voteSkipUsers.clear();
        const autoFilled = await checkAndAutoFillQueue();
        if (autoFilled.length > 0) logMessage += `\n🤖 *[Auto-Fill]* คิวเพลงเหลือน้อย บอทช่วยเติมเพลงฮิตพ่วงท้ายให้เรียบร้อยครับ`;

        const feedChannel = interaction.guild?.channels.cache.find(ch => ch.name === 'jookcast-feed' && ch.isTextBased()) as TextChannel;
        if (feedChannel) {
          await feedChannel.send({ content: logMessage, flags: [4096] });
        }
      } catch (error: any) { 
        console.error('❌ ดึงข้อมูลเข้าเพลย์ลิสต์พลาด:', error); 
      }
    }
  }
});

// ─── 🌐 Web Server + Full Automation OAuth Callback Endpoints ───────────────
const PORT = process.env.PORT ?? '10000';

http.createServer(async (req, res) => {
  const parsedUrl = urlModule.parse(req.url || '', true);
  // ✨ จุดแก้ตายตัว: ทำความสะอาด URL เผื่อมีเครื่องหมาย // หลุดเข้ามา เพื่อให้ทำงานได้ทั้งคู่
  const cleanPathname = parsedUrl.pathname?.replace(/\/+/g, '/');

  if (cleanPathname === '/api/auth') {
    try {
      const oAuth2Client = getYouTubeOAuth2Client();
      const authUrl = oAuth2Client.generateAuthUrl({ access_type: 'offline', scope: SCOPES, prompt: 'consent' });
      res.writeHead(302, { Location: authUrl });
      res.end();
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`❌ เกิดข้อผิดพลาดฝั่งเซิร์ฟเวอร์: ${err.message}`);
    }
    return;
  }

  if (cleanPathname === '/api/callback') {
    const code = parsedUrl.query.code as string;
    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Missing code parameter');
      return;
    }

    try {
      const oAuth2Client = getYouTubeOAuth2Client();
      const { tokens } = await oAuth2Client.getToken(code);
      fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2), 'utf8');
      
      client.guilds.cache.forEach(async (guild) => {
        const feedChannel = guild.channels.cache.find(ch => ch.name === 'jookcast-feed' && ch.isTextBased()) as TextChannel;
        if (feedChannel) {
          await feedChannel.send('🔒 **[Host Notification]** บัญชี YouTube Host ได้รับการผูกสิทธิ์และต่ออายุ Token อัตโนมัติผ่านทางระบบเว็บเรียบร้อยแล้วจ้า!');
        }
      });

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>🔒 ล็อกอินบัญชี YouTube Host สำเร็จแล้ว!</h1><p>ระบบทำการบันทึกและจัดการผูกสิทธิ์หลังบ้านให้เสร็จสิ้น โดยส่งสัญญาณแจ้งกลับไปยัง Discord เรียบร้อย สามารถปิดหน้านี้ได้เลยครับพี่!</p>');
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`OAuth Automation Error: ${err.message}`);
    }
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(`jookCast Status: ${BOT_VERSION} is standing by! 🎙️🎵`);
}).listen(PORT, () => {
  console.log(`🌐 Web Server Automation Live on Port ${PORT}`);
});