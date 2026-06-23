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
  TextChannel
} from 'discord.js';
import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import http from 'http';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');
const TOKEN_PATH = path.join(__dirname, 'token.json');
const CONFIG_PATH = path.join(__dirname, 'config.json');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

// 📝 เวอร์ชันและบันทึกการอัปเดตระบบ
const BOT_VERSION = 'v2.6.0';
const RELEASE_NOTES = `✨ **มีอะไรใหม่ในเวอร์ชัน ${BOT_VERSION}**\n- 🤫 **Silent Log System:** ย้ายข้อความแจ้งเตือนแอดเพลงแยกไปที่ช่อง \`#jookcast-feed\` แบบเงียบกริบ ไม่มีเสียงตึ๊ง ไม่เปิดไฟแดงรบกวนใคร\n- 📖 ช่อง \`#jookcast-status\` สำหรับเก็บคู่มือการใช้งานและประวัติอัปเดตบอทให้อ่านง่าย ไม่ปนกับข้อความอื่น`;

let voteSkipUsers = new Set<string>();
const REQUIRED_VOTES = 3;

interface BotConfig {
  playlistId: string | null;
}

function loadConfig(): BotConfig {
  if (fs.existsSync(CONFIG_PATH)) {
    try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return { playlistId: process.env.PLAYLIST_ID ?? null }; }
  }
  return { playlistId: process.env.PLAYLIST_ID ?? null };
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

function getYouTubeOAuth2Client() {
  if (!fs.existsSync(CREDENTIALS_PATH)) throw new Error('ไม่พบไฟล์ credentials.json ในเครื่อง');
  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
  const { client_secret, client_id, redirect_uris } = credentials.installed;
  return new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
}

function getYouTubeClient() {
  if (!fs.existsSync(TOKEN_PATH)) throw new Error('บอทยังไม่ได้ล็อกอินบัญชี YouTube Host');
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
  if (!config.playlistId) throw new Error('ยังไม่ได้ตั้งค่าไอดี Playlist');
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

// ─── ระบบแยกช่องสัญญาณแชทอัตโนมัติ (Multi-Channel Setup) ──────────────────────────

async function setupStatusChannelAndNotify(client: Client) {
  const STATUS_CHANNEL = 'jookcast-status';
  const FEED_CHANNEL = 'jookcast-feed';
  
  for (const guild of client.guilds.cache.values()) {
    try {
      // 1. ตรวจสอบ/สร้างช่องคู่มือ #jookcast-status (Read-Only)
      let statusChan = guild.channels.cache.find(ch => ch.name === STATUS_CHANNEL && ch.isTextBased()) as TextChannel;
      if (!statusChan) {
        statusChan = await guild.channels.create({
          name: STATUS_CHANNEL,
          permissionOverwrites: [{ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.SendMessages], allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] }]
        });
      }

      // 2. ตรวจสอบ/สร้างช่องประวัติเพลงแอด #jookcast-feed (Read-Only)
      let feedChan = guild.channels.cache.find(ch => ch.name === FEED_CHANNEL && ch.isTextBased()) as TextChannel;
      if (!feedChan) {
        await guild.channels.create({
          name: FEED_CHANNEL,
          reason: 'ช่องสำหรับเก็บประวัติล็อกตู้เพลงแบบปิดเสียงแจ้งเตือน',
          permissionOverwrites: [{ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.SendMessages], allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] }]
        });
      }

      // 3. ส่งบอร์ดคู่มือเข้าช่องสเตตัส (ถ้ายังไม่เคยมี)
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

      // 4. แจ้งเตือนอัปเดตระบบ (Release Notes) หากเลขเวอร์ชันใหม่ขึ้น
      const isAlreadyNotified = messages.some(msg => msg.embeds.some(emb => emb.title?.includes(BOT_VERSION)));
      if (!isAlreadyNotified) {
        const updateEmbed = new EmbedBuilder()
          .setTitle(`🚀 บอท jookCast อัปเกรดระบบเป็นเวอร์ชัน ${BOT_VERSION}!`)
          .setDescription(RELEASE_NOTES)
          .setColor('#9b5de5')
          .setTimestamp();
        
        await statusChan.send({ embeds: [updateEmbed] });
      }

    } catch (err) {
      console.error(`❌ ไม่สามารถตั้งค่าแชนเนลระบบได้:`, err);
    }
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
  new SlashCommandBuilder().setName('lucky').setDescription('ระบบสุ่มเพลงขำๆ เข้าตู้ jookCast ดับเหงา'),
  
  new SlashCommandBuilder().setName('remove').setDescription('[Admin] ลบเพลงออกจากคิวตามลำดับตัวเลข')
    .addIntegerOption(opt => opt.setName('index').setDescription('ลำดับเพลงในคิว').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('clear_queue').setDescription('[Admin] ล้างเพลงทั้งหมดในตู้ jookCast ให้โล่งเอี่ยม')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
].map(cmd => cmd.toJSON());

client.once('ready', async () => {
  console.log(`🎙️ บอท jookCast ${BOT_VERSION} พร้อมใช้งานแล้ว!`);
  if (client.user?.id) {
    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN!);
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    await setupStatusChannelAndNotify(client);
  }
});

// ─── INTERACTION HANDLERS ───────────────────────────────────────────────────

client.on('interactionCreate', async (interaction) => {
  if (interaction.isChatInputCommand()) {
    const { commandName } = interaction;

    // 🔍 สั่งค้นหาเพลง (ผลลัพธ์ลอยขึ้นมาเห็นคนเดียว)
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
      } catch (error: any) { await interaction.editReply(`❌ ค้นหาล้มเหลว: ${error.message}`); }
    }

    // 🔗 สั่งแอดเพลงตรงๆ ผ่านลิงก์
    if (commandName === 'add') {
      const url = interaction.options.getString('url', true).trim();
      const videoId = extractVideoId(url);
      if (!videoId) return interaction.reply({ content: '❌ ลิงก์ YouTube ไม่ถูกต้องครับ', ephemeral: true });
      
      // ตอบกลับผู้ใช้ทันทีแบบเห็นคนเดียวเพื่อไม่ให้ห้องหลักรก
      await interaction.reply({ content: '⏳ กำลังส่งเพลงเข้าตู้คิวหลักให้ครับ...', ephemeral: true });

      try {
        const snippet = await addSongToPlaylist(videoId);
        let logMessage = `📥 **<@${interaction.user.id}>** ได้หยอดเพลงเข้าตู้หลักผ่านลิงก์:\n🎵 **ชื่อเพลง:** ${snippet?.title}\n🔗 ลิงก์: https://youtu.be/${videoId}`;
        
        voteSkipUsers.clear();
        const autoFilled = await checkAndAutoFillQueue();
        if (autoFilled.length > 0) logMessage += `\n🤖 *[Auto-Fill]* คิวเพลงเหลือน้อย บอทช่วยเติมเพลงฮิตพ่วงท้ายให้แล้วครับ`;

        // ส่งข้อความไปโผล่ที่ห้อง jookcast-feed แบบไร้เสียงกวนใจ
        const feedChannel = interaction.guild?.channels.cache.find(ch => ch.name === 'jookcast-feed' && ch.isTextBased()) as TextChannel;
        if (feedChannel) {
          await feedChannel.send({ content: logMessage, flags: [4096] });
        }
      } catch (error: any) { console.error(error); }
    }

    if (commandName === 'queue') {
      await interaction.deferReply();
      try {
        const autoFilled = await checkAndAutoFillQueue();
        const songs = await getPlaylistSongs(10);
        if (songs.length === 0) return interaction.editReply('📭 ตู้เพลงว่างเปล่าจ้า พิมพ์ `/search` มาเปิดเพลงสิ!');
        let text = songs.map((s, i) => `${i + 1}. **${s.snippet?.title}**`).join('\n');
        if (autoFilled.length > 0) text += `\n\n🤖 *[Auto-Fill]* เพลงคิวใกล้หมด เติมเทรนด์ติดอันดับ TH เพิ่มให้เรียบร้อย`;
        const embed = new EmbedBuilder().setTitle('📋 คิวเพลงปัจจุบันใน jookCast').setDescription(text).setColor('#9b5de5');
        await interaction.editReply({ embeds: [embed] });
      } catch (e: any) { await interaction.editReply(`❌ ผิดพลาด: ${e.message}`); }
    }

    if (commandName === 'nowplaying') {
      await interaction.deferReply();
      try {
        const songs = await getPlaylistSongs(1);
        if (songs.length === 0) return interaction.editReply('🔇 ไม่มีเพลงออนแอร์อยู่ครับ');
        const cur = songs[0]?.snippet;
        const embed = new EmbedBuilder().setTitle('📻 กำลังออนแอร์').setDescription(`🎵 **${cur?.title}**`).setColor('#00f5d4');
        await interaction.editReply({ embeds: [embed] });
      } catch (e: any) { await interaction.editReply(`❌ ผิดพลาด: ${e.message}`); }
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
      } catch (e: any) { await interaction.editReply(`❌ โหวตล้มเหลว: ${e.message}`); }
    }

    if (commandName === 'lucky') {
      await interaction.deferReply();
      const fun = ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://www.youtube.com/watch?v=kJQP7kiw5Fk'];
      const vId = extractVideoId(fun[Math.floor(Math.random() * fun.length)]!)!;
      try {
        const snip = await addSongToPlaylist(vId); voteSkipUsers.clear();
        await interaction.editReply(`🎲 **ตู้เพลงสุ่มนำโชคระเบิด!** เพิ่มเพลงลงคิวแล้ว:\n🎵 **ชื่อเพลง:** ${snip?.title}`);
      } catch (e: any) { await interaction.editReply(`❌ สุ่มล้มเหลว: ${e.message}`); }
    }

    if (commandName === 'remove') {
      await interaction.deferReply({ ephemeral: true });
      const idx = interaction.options.getInteger('index', true);
      try {
        const songs = await getPlaylistSongs(20);
        if (idx < 1 || idx > songs.length) return interaction.editReply(`❌ ลำดับไม่ถูกต้อง`);
        
        const targetSong = songs[idx - 1];
        if (!targetSong || !targetSong.id) return interaction.editReply(`❌ ไม่พบข้อมูลเพลงในลำดับดังกล่าว`);

        await removeSongFromPlaylist(targetSong.id);
        await interaction.editReply(`🗑️ ลบเพลงลำดับที่ ${idx} เรียบร้อย`);
      } catch (e: any) { await interaction.editReply(`❌ ลบเพลงล้มเหลว: ${e.message}`); }
    }

    if (commandName === 'clear_queue') {
      await interaction.deferReply({ ephemeral: true });
      try {
        let songs = await getPlaylistSongs(50);
        while (songs.length > 0) {
          for (const s of songs) { await removeSongFromPlaylist(s.id!); }
          songs = await getPlaylistSongs(50);
        }
        voteSkipUsers.clear();
        await interaction.editReply('🧹 เคลียร์เพลงเกลี้ยงตู้เรียบร้อยครับ');
      } catch (e: any) { await interaction.editReply(`❌ ล้มเหลว: ${e.message}`); }
    }
  }

  // 🎵 จัดการดรอปดาวน์เมนูจากการพิมพ์ /search 
  if (interaction.isStringSelectMenu()) {
    if (interaction.customId === 'search-select') {
      const selectedVideoId = interaction.values?.[0];
      if (!selectedVideoId) return interaction.reply({ content: '❌ ผิดพลาดในการดึงข้อมูลคิวเพลง', ephemeral: true });

      // ตอบกลับแบบลับๆ ให้จังหวะแรกเพื่อปิดเงียบแชทหลัก
      await interaction.reply({ content: '✅ เพิ่มเพลงเข้าสู่คลังหลักเรียบร้อยแล้ว!', ephemeral: true });

      try {
        const snippet = await addSongToPlaylist(selectedVideoId);
        let logMessage = `🎶 **<@${interaction.user.id}>** ได้เลือกเพลงหยอดเข้าตู้เรียบร้อย!\n🎵 **ชื่อเพลง:** ${snippet?.title}\n🔗 ลิงก์: https://youtu.be/${selectedVideoId}`;
        
        voteSkipUsers.clear();
        const autoFilled = await checkAndAutoFillQueue();
        if (autoFilled.length > 0) logMessage += `\n🤖 *[Auto-Fill]* คิวเพลงเหลือน้อย บอทช่วยเติมเพลงฮิตพ่วงท้ายให้เรียบร้อยครับ`;

        // ค้นหาห้อง jookcast-feed เพื่อโยนข้อความล็อกเข้าล็อกไปแบบไม่มีเสียง (Silent)
        const feedChannel = interaction.guild?.channels.cache.find(ch => ch.name === 'jookcast-feed' && ch.isTextBased()) as TextChannel;
        if (feedChannel) {
          await feedChannel.send({
            content: logMessage,
            flags: [4096] // 💡 Flag: SuppressNotifications ป้องกันการเปิดไฟแดงและการส่งเสียงเตือนตึ๊งกวนใจสมาชิก
          });
        }
      } catch (error: any) { console.error('❌ ดึงข้อมูลเข้าเพลย์ลิสต์พลาด:', error); }
    }
  }
});

// 🌐 พอร์ตเว็บเซิร์ฟเวอร์จำลองเพื่อหลอก Render ให้เปิดทำงานยาวๆ 24 ชม.
const PORT = process.env.PORT ?? '10000';
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(`jookCast Status: ${BOT_VERSION} is standing by! 🎙️🎵`);
}).listen(PORT);

if (!DISCORD_TOKEN) console.error('❌ ไม่พบ DISCORD_TOKEN ในระบบ Environment');
else client.login(DISCORD_TOKEN);