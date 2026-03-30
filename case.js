const fs = require('fs');
const fg = require('api-dylux');
const axios = require('axios');
const yts = require('yt-search');
const { igdl } = require('btch-downloader');
const util = require('util');
const fetch = require('node-fetch');
const { exec } = require('child_process');
const path = require('path');
const chalk = require('chalk');
const cheerio = require('cheerio');
const { writeFile } = require('./library/utils');

// =============== COLORS ===============
const colors = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    white: '\x1b[37m',
    cyan: '\x1b[36m',
    yellow: '\x1b[33m',
    magenta: '\x1b[35m',
    bgGreen: '\x1b[42m',
};

// =============== HELPERS ===============
function formatUptime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return `${h}h ${m}m ${s}s`;
}

function stylishReply(text) {
    return `\`\`\`\n${text}\n\`\`\``;
}

function checkFFmpeg() {
    return new Promise((resolve) => {
        exec('ffmpeg -version', (err) => resolve(!err));
    });
}

function jidDecode(jid = '') {
    if (!jid.includes(':')) return null;
    const [user, rest] = jid.split(':');
    const server = rest?.split('@')[1] ? `@${rest.split('@')[1]}` : '';
    return { user, server: server.replace('@', '') };
}

async function detectPlatform(url) {
    if (/instagram\.com/i.test(url)) return 'instagram';
    if (/facebook|fb\.watch/i.test(url)) return 'facebook';
    if (/tiktok\.com/i.test(url)) return 'tiktok';
    if (/twitter\.com|x\.com/i.test(url)) return 'twitter';
    return null;
}

async function downloadMedia(url) {
    const platform = await detectPlatform(url);
    if (!platform) throw new Error('Unsupported platform');

    try {
        const { data } = await axios.get(
            `https://api.agatz.xyz/api/${platform}?url=${encodeURIComponent(url)}`
        );

        if (data && data.data) {
            return {
                platform,
                type: data.data.type || 'video',
                url: data.data.url || data.data.video || data.data.image
            };
        }
    } catch (e) {
        console.log('API failed, using fallback...');
    }

    const form = new URLSearchParams();
    form.append('q', url);
    form.append('vt', 'home');

    const { data } = await axios.post('https://yt5s.io/api/ajaxSearch', form);
    if (!data || data.status !== 'ok') {
        throw new Error('Scraper failed');
    }

    const $ = cheerio.load(data.data);
    const mediaUrl =
        $('a[title="Download Video"]').attr('href') ||
        $('a.download-link-fb').attr('href') ||
        $('img').attr('src');

    if (!mediaUrl) {
        throw new Error('No media found');
    }

    return {
        platform,
        type: mediaUrl.includes('.mp4') ? 'video' : 'image',
        url: mediaUrl
    };
}

module.exports = async function handleCommand(
    trashcore,
    m,
    command,
    isGroup,
    isAdmin,
    groupAdmins,
    isBotAdmins,
    groupMeta,
    config
) {
    trashcore.decodeJid = (jid) => {
        if (!jid) return jid;
        if (/:\d+@/gi.test(jid)) {
            const decode = jidDecode(jid) || {};
            return decode.user && decode.server ? `${decode.user}@${decode.server}` : jid;
        }
        return jid;
    };

    const from = trashcore.decodeJid(m.key?.remoteJid || '');
    const sender = trashcore.decodeJid(m.key?.participant || m.key?.remoteJid || '');
    const participant = sender;
    const pushname = m.pushName || 'Unknown User';
    const body =
        m.message?.conversation ||
        m.message?.extendedTextMessage?.text ||
        m.message?.imageMessage?.caption ||
        m.message?.videoMessage?.caption ||
        '';

    const args = body.trim().split(/\s+/).slice(1);
    const text = args.join(' ');
    const time = new Date().toLocaleTimeString();

    const chatType = from.endsWith('@g.us') ? 'Group' : 'Private';
    const chatName = chatType === 'Group'
        ? (groupMeta?.subject || 'Unknown Group')
        : pushname;

    const botNumber = `${trashcore.user?.id?.split(':')[0]}@s.whatsapp.net`;
    const isOwner = sender === botNumber;

    const reply = async (text) => {
        return trashcore.sendMessage(
            from,
            { text: stylishReply(text) },
            { quoted: m }
        );
    };

    const ctx = m.message?.extendedTextMessage?.contextInfo || {};
    const quoted = ctx.quotedMessage || null;
    const quotedSender = trashcore.decodeJid(ctx.participant || from);
    const mentioned = ctx.mentionedJid?.map(trashcore.decodeJid) || [];

    console.log(
        chalk.bgHex('#8B4513').white.bold(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📥 INCOMING MESSAGE (${time})
👤 From: ${pushname} (${participant})
💬 Chat Type: ${chatType} - ${chatName}
🏷️ Command: ${command || '—'}
💭 Message: ${body || '—'}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`)
    );

    const getGroupData = async () => {
        const metadata = groupMeta || await trashcore.groupMetadata(from);
        const admins = metadata.participants.filter((p) => p.admin).map((p) => p.id);
        const botIsAdmin = admins.includes(botNumber);
        const senderIsAdmin = admins.includes(sender);
        return { metadata, admins, botIsAdmin, senderIsAdmin };
    };

    // --- 🚨 ANTILINK AUTO CHECK ---
    if (isGroup && global.antilink?.[from]?.enabled) {
        const linkPattern = /(https?:\/\/[^\s]+)/gi;

        if (linkPattern.test(body)) {
            const settings = global.antilink[from];
            const { botIsAdmin, senderIsAdmin } = await getGroupData();

            if (!senderIsAdmin && botIsAdmin) {
                try {
                    await trashcore.sendMessage(from, { delete: m.key });

                    await trashcore.sendMessage(from, {
                        text: `🚫 *Link detected and removed!*\nUser: @${sender.split('@')[0]}\nAction: ${settings.mode.toUpperCase()}`,
                        mentions: [sender],
                    });

                    if (settings.mode === 'kick') {
                        await trashcore.groupParticipantsUpdate(from, [sender], 'remove');
                    }
                } catch (err) {
                    console.error('Antilink Enforcement Error:', err);
                }
            }
        }
    }

    // --- 🚫 ANTI-TAG AUTO CHECK ---
    if (isGroup && global.antitag?.[from]?.enabled) {
        const settings = global.antitag[from];
        const mentionedUsers = m.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];

        if (mentionedUsers.length > 0) {
            const { botIsAdmin, senderIsAdmin } = await getGroupData();

            if (!senderIsAdmin && botIsAdmin) {
                try {
                    await trashcore.sendMessage(from, { delete: m.key });

                    await trashcore.sendMessage(from, {
                        text: `🚫 *Tagging others is not allowed!*\nUser: @${sender.split('@')[0]}\nAction: ${settings.mode.toUpperCase()}`,
                        mentions: [sender],
                    });

                    if (settings.mode === 'kick') {
                        await trashcore.groupParticipantsUpdate(from, [sender], 'remove');
                    }
                } catch (err) {
                    console.error('Anti-Tag Enforcement Error:', err);
                }
            }
        }
    }

    // --- 🚫 ANTI BAD WORD AUTO CHECK ---
    if (isGroup && global.antibadword?.[from]?.enabled) {
        const settings = global.antibadword[from];
        const badwords = settings.words || [];
        const textMsg = body.toLowerCase();
        const found = badwords.find((word) => textMsg.includes(word.toLowerCase()));

        if (found) {
            const { botIsAdmin, senderIsAdmin } = await getGroupData();

            if (!senderIsAdmin) {
                try {
                    if (botIsAdmin) {
                        await trashcore.sendMessage(from, { delete: m.key });
                    }

                    if (!settings.warnings) settings.warnings = {};
                    settings.warnings[sender] = (settings.warnings[sender] || 0) + 1;

                    const warns = settings.warnings[sender];
                    const remaining = 3 - warns;

                    if (warns < 3) {
                        await trashcore.sendMessage(from, {
                            text: `⚠️ @${sender.split('@')[0]}, bad word detected!\nWord: *${found}*\nWarning: *${warns}/3*\n${remaining} more and you'll be kicked!`,
                            mentions: [sender],
                        });
                    } else {
                        if (botIsAdmin) {
                            await trashcore.sendMessage(from, {
                                text: `🚫 @${sender.split('@')[0]} has been kicked for repeated bad words.`,
                                mentions: [sender],
                            });

                            await trashcore.groupParticipantsUpdate(from, [sender], 'remove');
                            delete settings.warnings[sender];
                        } else {
                            await trashcore.sendMessage(from, {
                                text: `🚨 @${sender.split('@')[0]} reached 3 warnings, but I need admin rights to kick!`,
                                mentions: [sender],
                            });
                        }
                    }
                } catch (err) {
                    console.error('AntiBadWord Enforcement Error:', err);
                }
            }
        }
    }

    if (!trashcore.isPublic && !isOwner) return;

    try {
        switch (command) {
            case 'ping':
            case 'alive': {
                const start = Date.now();
                await reply('⏳ Pinging...');
                const latency = Date.now() - start;

                await reply(`Pong!
Latency: ${latency}ms
Uptime: ${formatUptime(process.uptime())}
Owner: Trashcore`);
                break;
            }

            case 'menu':
            case 'help': {
                const menuText = `╔═══〔 ☀️ 𝐄𝐒𝐂𝐀𝐍𝐎𝐑 𝐌𝐃 ☀️ 〕═══╗  
║        🔥 𝗕𝗢𝗧 𝗠𝗘𝗡𝗨 🔥        ║  
╚════════════════════════════╝  

👑 Created By: Sins.Outlaw × Escanor Md  
⚡ Version: 1.0.0  
📦 Module: Case Handler  

╭───〔 📊 SYSTEM 〕───╮  
│ • ping  
│ • public  
│ • private  
╰───────────────────╯  

╭───〔 🥁 ANALYSIS 〕───╮  
│ • weather  
│ • checktime  
│ • gitclone  
│ • save  
╰───────────────────╯  

╭───〔 🛟 MEDIA 〕───╮  
│ • tiktok  
│ • play  
│ • igdl  
│ • fb  
│ • video  
│ • playdoc  
╰───────────────────╯  

╭───〔 👥 GROUP 〕───╮  
│ • add  
│ • kick  
│ • promote  
│ • demote  
│ • antilink  
│ • antitag  
│ • antipromote  
│ • antidemote  
│ • antibadword  
│ • tagall  
│ • hidetag  
╰───────────────────╯  

╭───〔 📍 CONVERTER 〕───╮  
│ • toaudio  
│ • tovoicenote  
│ • toimage  
╰───────────────────╯  

╭───〔 👤 BASIC 〕───╮  
│ • copilot  
│ • >  
│ • <  
│ • =>  
╰───────────────────╯  

╔═══〔 🌞 𝐄𝐒𝐂𝐀𝐍𝐎𝐑 𝐏𝐎𝐖𝐄𝐑 🌞 〕═══╗  
║   "𝗧𝗵𝗲 𝗢𝗻𝗲 𝗪𝗵𝗼 𝗦𝘁𝗮𝗻𝗱𝘀 𝗔𝗯𝗼𝘃𝗲 𝗔𝗹𝗹"   ║  
╚════════════════════════════╝`;

                const escanorClips = [
                    'https://files.catbox.moe/yd6w3c.mp4',
                    'https://files.catbox.moe/3rjbby.mp4',
                    'https://files.catbox.moe/mn0u29.mp4',
                    'https://files.catbox.moe/eyoq4v.mp4'
                ];

                const getRandomEscanor = () =>
                    escanorClips[Math.floor(Math.random() * escanorClips.length)];

                try {
                    const videoUrl = getRandomEscanor();

                    await trashcore.sendMessage(
                        from,
                        {
                            video: { url: videoUrl },
                            caption: stylishReply(menuText),
                            gifPlayback: true,
                            mimetype: 'video/mp4'
                        },
                        { quoted: m }
                    );
                } catch (err) {
                    console.error('Escanor video failed:', err);
                    await reply(menuText);
                }
                break;
            }

            // ================= WEATHER =================
            case 'weather': {
                try {
                    if (!text) return reply('🌍 Please provide a city or town name!');

                    const query = encodeURIComponent(text);
                    const apiKey = '1ad47ec6172f19dfaf89eb3307f74785';
                    const response = await fetch(`https://api.openweathermap.org/data/2.5/weather?q=${query}&units=metric&appid=${apiKey}`);
                    const data = await response.json();

                    if (!response.ok || data.cod !== 200) {
                        return reply('❌ Unable to find that location. Please check the spelling.');
                    }

                    const weatherText = `🌤️ Weather Report for ${data.name}
🌡️ Temperature: ${data.main?.temp ?? 'N/A'}°C
🌬️ Feels Like: ${data.main?.feels_like ?? 'N/A'}°C
🌧️ Rain Volume: ${data.rain?.['1h'] || 0} mm
☁️ Cloudiness: ${data.clouds?.all ?? 'N/A'}%
💧 Humidity: ${data.main?.humidity ?? 'N/A'}%
🌪️ Wind Speed: ${data.wind?.speed ?? 'N/A'} m/s
📝 Condition: ${data.weather?.[0]?.description || 'N/A'}
🌄 Sunrise: ${new Date((data.sys?.sunrise || 0) * 1000).toLocaleTimeString()}
🌅 Sunset: ${new Date((data.sys?.sunset || 0) * 1000).toLocaleTimeString()}`;

                    await reply(weatherText);
                } catch (err) {
                    console.error('Weather command error:', err);
                    await reply('❌ Unable to retrieve weather information.');
                }
                break;
            }

            // ================= CHECKTIME =================
            case 'checktime':
            case 'time': {
                try {
                    if (!text) {
                        return reply('🌍 Please provide a city or country name to check the local time.');
                    }

                    await reply(`⏳ Checking local time for *${text}*...`);

                    const tzRes = await fetch('https://worldtimeapi.org/api/timezone');
                    const timezones = await tzRes.json();

                    if (!Array.isArray(timezones)) {
                        return reply('❌ Unable to fetch timezone list right now.');
                    }

                    const search = text.toLowerCase().trim();
                    const match = timezones.find((tz) => tz.toLowerCase().includes(search));

                    if (!match) {
                        return reply(`❌ Could not find timezone for *${text}*.`);
                    }

                    const res = await fetch(`https://worldtimeapi.org/api/timezone/${encodeURIComponent(match)}`);
                    const data = await res.json();

                    if (!res.ok || !data?.datetime) {
                        return reply(`❌ Unable to fetch time for *${text}*.`);
                    }

                    const datetime = new Date(data.datetime);
                    const hours = datetime.getHours();

                    const greeting =
                        hours < 12
                            ? '🌅 Good Morning'
                            : hours < 18
                                ? '🌞 Good Afternoon'
                                : '🌙 Good Evening';

                    const timeText = `🕒 Local Time in ${text}
${greeting} 👋
📍 Timezone: ${data.timezone}
⏰ Time: ${datetime.toLocaleTimeString()}
📆 Date: ${datetime.toDateString()}
⏱️ Uptime: ${formatUptime(process.uptime())}`;

                    await reply(timeText);
                } catch (err) {
                    console.error('Checktime error:', err);
                    await reply('❌ Unable to fetch time for that city.');
                }
                break;
            }

            // ================= GITCLONE =================
            case 'gitclone': {
                try {
                    if (!args[0]) return reply('❌ Provide a GitHub repo link.');

                    const repoUrl = args[0].trim();
                    if (!repoUrl.includes('github.com')) {
                        return reply('❌ Not a valid GitHub link!');
                    }

                    const regex = /(?:https|git)(?::\/\/|@)github\.com[/:]([^/:]+)\/(.+?)(?:\.git)?$/i;
                    const match = repoUrl.match(regex);

                    if (!match) {
                        return reply('❌ Could not parse that GitHub repository link.');
                    }

                    const [, user, repo] = match;
                    const cleanRepo = repo.replace(/\.git$/i, '');
                    const zipUrl = `https://api.github.com/repos/${user}/${cleanRepo}/zipball`;

                    const head = await fetch(zipUrl, { method: 'HEAD' });
                    if (!head.ok) {
                        return reply('❌ Failed to fetch repository archive.');
                    }

                    const contentDisp = head.headers.get('content-disposition');
                    const filenameMatch = contentDisp?.match(/filename="?([^"]+)"?/i);
                    const filename = filenameMatch ? filenameMatch[1] : `${cleanRepo}.zip`;

                    await trashcore.sendMessage(
                        from,
                        {
                            document: { url: zipUrl },
                            fileName: filename,
                            mimetype: 'application/zip'
                        },
                        { quoted: m }
                    );

                    await reply(`✅ Successfully fetched repository: *${user}/${cleanRepo}*`);
                } catch (err) {
                    console.error('Gitclone error:', err);
                    await reply('❌ Failed to clone repository.');
                }
                break;
            }

            // ================= SAVE STATUS =================
         case 'save': {
  try {
    if (!quoted) return reply('❌ Reply to any media message!');

    // Get actual message content safely
    const msg = quoted.message || quoted;

    // Download media
    const mediaBuffer = await trashcore.downloadMediaMessage(quoted);
    if (!mediaBuffer) {
      return reply('🚫 Could not download media.');
    }

    let payload = {};
    let caption = '✅ Saved by Escanor';

    // Detect media type
    if (msg?.imageMessage) {
      payload = {
        image: mediaBuffer,
        caption: msg.imageMessage.caption || caption
      };

    } else if (msg?.videoMessage) {
      payload = {
        video: mediaBuffer,
        caption: msg.videoMessage.caption || caption
      };

    } else if (msg?.audioMessage) {
      payload = {
        audio: mediaBuffer,
        mimetype: 'audio/mpeg',
        ptt: msg.audioMessage.ptt || false // voice note or not
      };

    } else if (msg?.stickerMessage) {
      payload = {
        sticker: mediaBuffer
      };

    } else if (msg?.documentMessage) {
      payload = {
        document: mediaBuffer,
        mimetype: msg.documentMessage.mimetype,
        fileName: msg.documentMessage.fileName || 'file'
      };

    } else {
      return reply('❌ Unsupported media type!');
    }

    // Send to user DM
    await trashcore.sendMessage(sender, payload, { quoted: m });

    await reply('✅ Media saved successfully!');

  } catch (err) {
    console.error('Save error:', err);
    reply('❌ Failed to save media.');
  }
  break;
}

            // ================= IG / FB DL =================
            case 'fb':
            case 'facebook':
            case 'fbdl':
            case 'ig':
            case 'instagram':
            case 'igdl': {
                try {
    if (!args[0]) return reply('❌ Provide a link!');

    const url = args[0].trim();

    await reply('⏳ Processing...');

    const media = await downloadMedia(url);

    if (!media) return reply('❌ Failed to fetch media.');

    await reply(`📥 Downloading from ${media.platform}...`);

    if (media.type === 'video') {
      await trashcore.sendMessage(from, {
        video: { url: media.url },
        caption: `✅ ${media.platform} video downloaded`
      }, { quoted: m });

    } else {
      await trashcore.sendMessage(from, {
        image: { url: media.url },
        caption: `✅ ${media.platform} image downloaded`
      }, { quoted: m });
    }

    await trashcore.sendMessage(from, { react: { text: '🔥', key: m.key } });

  } catch (err) {
    console.error(err);
    reply('❌ Download failed.');
  }
  break;
}

            // ================= TIKTOK =================
            case 'tiktok': {
    try {
        if (!args[0]) return reply('⚠️ Provide a TikTok link.');

        await reply('⏳ Fetching TikTok data...');

        const data = await fg.tiktok(args[0]);
        const json = data?.result;

        if (!json) {
            return reply('❌ No TikTok data returned.');
        }

        // 📌 Choose best playable video (fallback system)
        let videoUrl = json.play || json.wm || json.hdplay || null;

        if (!videoUrl) {
            return reply('❌ No downloadable video found.');
        }

        // 📌 Clean caption
        let caption = `🎵 *TIKTOK DOWNLOAD*\n\n`;
        caption += `◦ User: ${json.author?.nickname || 'N/A'}\n`;
        caption += `◦ Title: ${json.title || 'N/A'}\n`;
        caption += `◦ ❤️ Likes: ${json.digg_count || 0}\n`;
        caption += `◦ 💬 Comments: ${json.comment_count || 0}\n`;
        caption += `◦ ▶️ Views: ${json.play_count || 0}`;

        // 📌 IMAGE POSTS
        if (Array.isArray(json.images) && json.images.length > 0) {
            for (const img of json.images) {
                await trashcore.sendMessage(from, {
                    image: { url: img }
                }, { quoted: m });
            }
            return reply(stylishReply(caption));
        }

        // 📌 VIDEO SEND (WhatsApp FIXED)
        await trashcore.sendMessage(from, {
            video: { url: videoUrl },
            mimetype: 'video/mp4',
            caption: stylishReply(caption),
            gifPlayback: false
        }, { quoted: m });

        // 📌 AUDIO (Optional)
        if (json.music) {
            setTimeout(async () => {
                try {
                    await trashcore.sendMessage(from, {
                        audio: { url: json.music },
                        mimetype: 'audio/mpeg',
                        ptt: false
                    }, { quoted: m });
                } catch (e) {
                    console.error('Audio error:', e);
                }
            }, 1500);
        }

    } catch (err) {
        console.error('TikTok command error:', err);
        await reply('❌ Failed to fetch TikTok data. Make sure the link is valid.');
    }
    break;
}

            // ================= VIDEO =================
            case 'video': {
    try {
        if (!text) return reply('❌ What video do you want to download?');

        let videoUrl = '';
        let videoTitle = '';
        let videoThumbnail = '';

        // 🔍 SEARCH OR DIRECT LINK
        if (/^https?:\/\//i.test(text)) {
            videoUrl = text.trim();
        } else {
            const searchResult = await yts(text);
            const videos = searchResult?.videos || [];

            if (!videos.length) return reply('❌ No videos found!');

            videoUrl = videos[0].url;
            videoTitle = videos[0].title;
            videoThumbnail = videos[0].thumbnail;
        }

        // ✅ VALIDATE YOUTUBE
        const isYoutubeUrl = /(?:youtu\.be\/|youtube\.com\/)/i.test(videoUrl);
        if (!isYoutubeUrl) return reply('❌ Invalid YouTube link!');

        // ⚙️ CONFIG
        const API_HEADERS = {
            timeout: 60000,
            headers: {
                'User-Agent': 'Mozilla/5.0',
                Accept: 'application/json'
            }
        };

        const wait = (ms) => new Promise(res => setTimeout(res, ms));

        const tryRequest = async (fn, attempts = 3) => {
            let err;
            for (let i = 0; i < attempts; i++) {
                try {
                    return await fn();
                } catch (e) {
                    err = e;
                    await wait(1000 * (i + 1));
                }
            }
            throw err;
        };

        // 🔥 MULTI API SYSTEM
        const apis = [
            async () => {
                const res = await tryRequest(() =>
                    axios.get(`https://izumiiiiiiii.dpdns.org/downloader/youtube?url=${encodeURIComponent(videoUrl)}&format=720`, API_HEADERS)
                );
                return res?.data?.result?.download;
            },
            async () => {
                const res = await tryRequest(() =>
                    axios.get(`https://okatsu-rolezapiiz.vercel.app/downloader/ytmp4?url=${encodeURIComponent(videoUrl)}`, API_HEADERS)
                );
                return res?.data?.result?.mp4;
            }
        ];

        // 🎯 FETCH VIDEO FROM ANY WORKING API
        let downloadUrl = null;
        for (const api of apis) {
            try {
                downloadUrl = await api();
                if (downloadUrl) break;
            } catch (e) {
                console.warn('[VIDEO API FAILED]', e.message);
            }
        }

        if (!downloadUrl) {
            return reply('❌ All video sources failed.');
        }

        // 🖼️ THUMBNAIL
        try {
            const ytId = (videoUrl.match(/(?:v=|youtu\.be\/|shorts\/)([a-zA-Z0-9_-]{11})/) || [])[1];
            const thumb = videoThumbnail || (ytId ? `https://i.ytimg.com/vi/${ytId}/hqdefault.jpg` : null);

            if (thumb) {
                await trashcore.sendMessage(from, {
                    image: { url: thumb },
                    caption: `🎬 *${videoTitle || 'Video'}*\n⏳ Downloading...`
                }, { quoted: m });
            }
        } catch {}

        // ⚡ BUFFER FIX (Prevents "Can't Play Video")
        let videoBuffer;
        try {
            const res = await axios.get(downloadUrl, {
                responseType: 'arraybuffer',
                timeout: 120000
            });
            videoBuffer = res.data;
        } catch (bufferErr) {
            console.warn('Buffer failed, sending URL directly...');
        }

        // 📤 SEND VIDEO
        await trashcore.sendMessage(from, {
            video: videoBuffer ? videoBuffer : { url: downloadUrl },
            mimetype: 'video/mp4',
            fileName: `${videoTitle || 'video'}.mp4`,
            caption: `🎥 *${videoTitle || 'Video'}*`
        }, { quoted: m });

    } catch (error) {
        console.error('[VIDEO ERROR]', error);
        await reply('❌ Failed to download video.');
    }
    break;
}
            // ================= PLAY =================
            case 'play': {
    try {
        if (!args.length) {
            return reply(`🎵 Provide a song name!\nExample: .play Anybody Burna Boy`);
        }

        const query = args.join(' ');
        await reply('🔎 Searching song...');

        // 🔍 YouTube search
        const search = await yts(`${query} official audio`);
        const video = search?.videos?.[0];

        if (!video) return reply('❌ Song not found!');

        const title = video.title;
        const url = video.url;
        const thumb = video.thumbnail;

        // 🖼️ Preview
        await trashcore.sendMessage(from, {
            image: { url: thumb },
            caption: `🎶 *${title}*\n⏳ Converting to voice note...`
        }, { quoted: m });

        // 🔥 APIs
        const apis = [
            `https://api.privatezia.biz.id/api/downloader/ytmp3?url=${encodeURIComponent(url)}`,
            `https://okatsu-rolezapiiz.vercel.app/downloader/ytmp3?url=${encodeURIComponent(url)}`
        ];

        let audioUrl = null;

        for (const api of apis) {
            try {
                const { data } = await axios.get(api, { timeout: 60000 });
                audioUrl = data?.result?.downloadUrl || data?.result?.mp3;
                if (audioUrl) break;
            } catch {}
        }

        if (!audioUrl) return reply('❌ Failed to fetch audio.');

        // ⚡ FETCH BUFFER (IMPORTANT FOR QUALITY)
        const audioBuffer = await axios.get(audioUrl, {
            responseType: 'arraybuffer',
            timeout: 120000
        });

        // 🎧 SEND AS VOICE NOTE (HQ)
        await trashcore.sendMessage(from, {
            audio: audioBuffer.data,
            mimetype: 'audio/ogg; codecs=opus',
            ptt: true // 🔥 this makes it voice note
        }, { quoted: m });

    } catch (err) {
        console.error('Play VN error:', err);
        await reply('❌ Error processing voice note.');
    }
    break;
}

            // ================= TO AUDIO =================
            case 'toaudio': {
                try {
                    const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
                    const ffmpeg = require('fluent-ffmpeg');
                    const { writeFileSync, readFileSync, unlinkSync, existsSync } = require('fs');
                    const { tmpdir } = require('os');

                    const source = m.quoted ? m.quoted : m;
                    const msg = source.msg || source.message?.videoMessage || source.message?.audioMessage;
                    const mime = msg?.mimetype || source.mimetype || '';

                    if (!msg) {
                        return reply('🎧 Reply to a *video* or *audio* to convert it to audio!');
                    }

                    if (!/video|audio/.test(mime)) {
                        return reply('⚠️ Only works on *video* or *audio* messages!');
                    }

                    const ffmpegReady = await checkFFmpeg();
                    if (!ffmpegReady) {
                        return reply('❌ FFmpeg is not installed on this server.');
                    }

                    await reply('🎶 Converting to audio...');

                    const messageType = mime.split('/')[0];
                    const stream = await downloadContentFromMessage(msg, messageType);

                    let buffer = Buffer.from([]);
                    for await (const chunk of stream) {
                        buffer = Buffer.concat([buffer, chunk]);
                    }

                    const inputExt = messageType === 'video' ? 'mp4' : 'mp3';
                    const inputPath = path.join(tmpdir(), `input_${Date.now()}.${inputExt}`);
                    const outputPath = path.join(tmpdir(), `output_${Date.now()}.mp3`);

                    writeFileSync(inputPath, buffer);

                    await new Promise((resolve, reject) => {
                        ffmpeg(inputPath)
                            .toFormat('mp3')
                            .on('end', resolve)
                            .on('error', reject)
                            .save(outputPath);
                    });

                    const audioBuffer = readFileSync(outputPath);

                    await trashcore.sendMessage(
                        from,
                        {
                            audio: audioBuffer,
                            mimetype: 'audio/mpeg',
                            ptt: false
                        },
                        { quoted: m }
                    );

                    if (existsSync(inputPath)) unlinkSync(inputPath);
                    if (existsSync(outputPath)) unlinkSync(outputPath);

                    await reply('✅ Conversion complete!');
                } catch (err) {
                    console.error('toaudio error:', err);
                    await reply('💥 Failed to convert media to audio. Ensure it is a valid video/audio file.');
                }
                break;
            }

            // ================= TO VOICE NOTE =================
            case 'tovoicenote': {
                try {
                    const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
                    const ffmpeg = require('fluent-ffmpeg');
                    const { writeFileSync, readFileSync, unlinkSync, existsSync } = require('fs');
                    const { tmpdir } = require('os');

                    const source = m.quoted ? m.quoted : m;
                    const msg = source.msg || source.message?.videoMessage || source.message?.audioMessage;
                    const mime = msg?.mimetype || source.mimetype || '';

                    if (!msg) {
                        return reply('🎧 Reply to a *video* or *audio* to convert it to a voice note!');
                    }

                    if (!/video|audio/.test(mime)) {
                        return reply('⚠️ Only works on *video* or *audio* messages!');
                    }

                    const ffmpegReady = await checkFFmpeg();
                    if (!ffmpegReady) {
                        return reply('❌ FFmpeg is not installed on this server.');
                    }

                    await reply('🔊 Converting to voice note...');

                    const messageType = mime.split('/')[0];
                    const stream = await downloadContentFromMessage(msg, messageType);

                    let buffer = Buffer.from([]);
                    for await (const chunk of stream) {
                        buffer = Buffer.concat([buffer, chunk]);
                    }

                    const inputExt = messageType === 'video' ? 'mp4' : 'mp3';
                    const inputPath = path.join(tmpdir(), `input_${Date.now()}.${inputExt}`);
                    const outputPath = path.join(tmpdir(), `output_${Date.now()}.ogg`);

                    writeFileSync(inputPath, buffer);

                    await new Promise((resolve, reject) => {
                        ffmpeg(inputPath)
                            .audioCodec('libopus')
                            .audioBitrate('64k')
                            .toFormat('ogg')
                            .on('end', resolve)
                            .on('error', reject)
                            .save(outputPath);
                    });

                    const audioBuffer = readFileSync(outputPath);

                    await trashcore.sendMessage(
                        from,
                        {
                            audio: audioBuffer,
                            mimetype: 'audio/ogg; codecs=opus',
                            ptt: true
                        },
                        { quoted: m }
                    );

                    if (existsSync(inputPath)) unlinkSync(inputPath);
                    if (existsSync(outputPath)) unlinkSync(outputPath);

                    await reply('✅ Voice note sent!');
                } catch (err) {
                    console.error('tovoicenote error:', err);
                    await reply('💥 Failed to convert media to voice note. Make sure it is a valid video/audio file.');
                }
                break;
            }

            // ================= TO IMAGE =================
            case 'toimage': {
                try {
                    const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
                    const sharp = require('sharp');
                    const { readFileSync, unlinkSync, existsSync } = require('fs');
                    const { tmpdir } = require('os');

                    const source = m.quoted ? m.quoted : m;
                    const msg = source.msg || source.message?.stickerMessage;

                    if (!msg || !msg.mimetype?.includes('webp')) {
                        return reply('⚠️ Reply to a *sticker* to convert it to an image!');
                    }

                    await reply('🖼️ Converting sticker to image...');

                    const stream = await downloadContentFromMessage(msg, 'sticker');
                    let buffer = Buffer.from([]);

                    for await (const chunk of stream) {
                        buffer = Buffer.concat([buffer, chunk]);
                    }

                    const outputPath = path.join(tmpdir(), `sticker_${Date.now()}.png`);
                    await sharp(buffer).png().toFile(outputPath);

                    const imageBuffer = readFileSync(outputPath);

                    await trashcore.sendMessage(from, { image: imageBuffer }, { quoted: m });

                    if (existsSync(outputPath)) unlinkSync(outputPath);
                    await reply('✅ Sticker converted to image!');
                } catch (err) {
                    console.error('toimage error:', err);
                    await reply('💥 Failed to convert sticker to image.');
                }
                break;
            }

            // ================= PRIVATE / SELF / PUBLIC=================
case 'private':
case 'self': {
    if (!isOwner) return reply('❌ Owner only.');

    trashcore.isPublic = false;
    reply('🔒 Bot is now in PRIVATE mode.');
    break;
}

case 'public': {
    if (!isOwner) return reply('❌ Owner only.');

    trashcore.isPublic = true;
    reply('🌍 Bot is now PUBLIC.');
    break;
}

case 'mode': {
    reply(`⚙️ Mode: ${trashcore.isPublic ? 'PUBLIC 🌍' : 'PRIVATE 🔒'}`);
    break;
}

            // ================= PLAYDOC =================
            case 'playdoc': {
                try {
                    const tempDir = path.join(__dirname, 'temp');
                    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

                    if (!args.length) {
                        return reply(`🎵 Provide a song name!\nExample: ${command} Not Like Us`);
                    }

                    const query = args.join(' ').trim();
                    if (query.length > 100) {
                        return reply('📝 Song name too long! Max 100 chars.');
                    }

                    await reply('🎧 Searching for the track... ⏳');

                    const search = await yts(`${query} official audio`);
                    const video = search?.videos?.[0];

                    if (!video) {
                        return reply("😕 Couldn't find that song. Try another one!");
                    }

                    const apiUrl = `https://api.privatezia.biz.id/api/downloader/ytmp3?url=${encodeURIComponent(video.url)}`;
                    const { data: apiData } = await axios.get(apiUrl, { timeout: 60000 });

                    if (!apiData?.status || !apiData?.result?.downloadUrl) {
                        throw new Error('API failed to fetch track!');
                    }

                    const safeTitle = (apiData.result.title || video.title || 'audio')
                        .replace(/[\\/:*?"<>|]/g, '')
                        .slice(0, 100);

                    const filePath = path.join(tempDir, `audio_${Date.now()}.mp3`);

                    const audioResponse = await axios({
                        method: 'get',
                        url: apiData.result.downloadUrl,
                        responseType: 'stream',
                        timeout: 600000
                    });

                    const writer = fs.createWriteStream(filePath);
                    audioResponse.data.pipe(writer);

                    await new Promise((resolve, reject) => {
                        writer.on('finish', resolve);
                        writer.on('error', reject);
                    });

                    if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) {
                        throw new Error('Download failed or empty file!');
                    }

                    await trashcore.sendMessage(
                        from,
                        { text: stylishReply(`🎶 Downloaded *${safeTitle}* 🎧`) },
                        { quoted: m }
                    );

                    await trashcore.sendMessage(
                        from,
                        {
                            document: { url: filePath },
                            mimetype: 'audio/mpeg',
                            fileName: `${safeTitle}.mp3`
                        },
                        { quoted: m }
                    );

                    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
                } catch (error) {
                    console.error('Playdoc command error:', error);
                    await reply(`💥 Error: ${error.message}`);
                }
                break;
            }

            // ================= ANTILINK =================
            case 'antilink': {
                try {
                    if (!isGroup) return reply('❌ This command only works in groups!');
                    if (!isAdmin && !isOwner) return reply('⚠️ Only group admins or the owner can use this command!');

                    global.antilink = global.antilink || {};
                    const chatId = from;

                    if (!global.antilink[chatId]) {
                        global.antilink[chatId] = {
                            enabled: false,
                            mode: 'delete'
                        };
                    }

                    const option = args[0]?.toLowerCase();
                    const modeType = args[1]?.toLowerCase();

                    if (option === 'on') {
                        global.antilink[chatId].enabled = true;
                        return reply(`✅ *Antilink enabled!*\nMode: ${global.antilink[chatId].mode.toUpperCase()}`);
                    }

                    if (option === 'off') {
                        global.antilink[chatId].enabled = false;
                        return reply('❎ Antilink disabled!');
                    }

                    if (option === 'mode') {
                        if (!modeType || !['delete', 'kick'].includes(modeType)) {
                            return reply('⚙️ Usage: `.antilink mode delete` or `.antilink mode kick`');
                        }

                        if (modeType === 'kick' && !isBotAdmins) {
                            return reply('🚫 I need admin privileges before kick mode can work!');
                        }

                        global.antilink[chatId].mode = modeType;
                        return reply(`🔧 Antilink mode set to *${modeType.toUpperCase()}*!`);
                    }

                    return reply(
                        `📢 *Antilink Settings*\n\n` +
                        `• Status: ${global.antilink[chatId].enabled ? '✅ ON' : '❎ OFF'}\n` +
                        `• Mode: ${global.antilink[chatId].mode.toUpperCase()}\n\n` +
                        `🧩 Usage:\n` +
                        `- .antilink on\n` +
                        `- .antilink off\n` +
                        `- .antilink mode delete\n` +
                        `- .antilink mode kick`
                    );
                } catch (err) {
                    console.error('Antilink command error:', err);
                    await reply('💥 Error while updating antilink settings.');
                }
                break;
            }
            // ================= ANTITAG =================
            case 'antitag': {
                try {
                    if (!isGroup) return reply('❌ This command only works in groups!');
                    if (!isAdmin && !isOwner) return reply('⚠️ Only group admins or the owner can use this command!');

                    global.antitag = global.antitag || {};
                    const chatId = from;

                    if (!global.antitag[chatId]) {
                        global.antitag[chatId] = { enabled: false, mode: 'delete' };
                    }

                    const option = args[0]?.toLowerCase();
                    const modeType = args[1]?.toLowerCase();

                    if (option === 'on') {
                        global.antitag[chatId].enabled = true;
                        return reply(`✅ *AntiTag enabled!*\nMode: ${global.antitag[chatId].mode.toUpperCase()}`);
                    }

                    if (option === 'off') {
                        global.antitag[chatId].enabled = false;
                        return reply('❎ AntiTag disabled!');
                    }

                    if (option === 'mode') {
                        if (!modeType || !['delete', 'kick'].includes(modeType)) {
                            return reply('⚙️ Usage: `.antitag mode delete` or `.antitag mode kick`');
                        }

                        if (modeType === 'kick' && !isBotAdmins) {
                            return reply('🚫 I need admin privileges before kick mode can work!');
                        }

                        global.antitag[chatId].mode = modeType;
                        return reply(`🔧 AntiTag mode set to *${modeType.toUpperCase()}*!`);
                    }

                    return reply(
                        `📢 *AntiTag Settings*\n\n` +
                        `• Status: ${global.antitag[chatId].enabled ? '✅ ON' : '❎ OFF'}\n` +
                        `• Mode: ${global.antitag[chatId].mode.toUpperCase()}\n\n` +
                        `🧩 Usage:\n` +
                        `- .antitag on\n` +
                        `- .antitag off\n` +
                        `- .antitag mode delete\n` +
                        `- .antitag mode kick`
                    );
                } catch (err) {
                    console.error('AntiTag command error:', err);
                    await reply('💥 Error while updating AntiTag settings.');
                }
                break;
            }

            // ================= ANTIDEMOTE =================
            case 'antidemote': {
                try {
                    if (!isGroup) return reply('❌ This command only works in groups!');
                    if (!isAdmin && !isOwner) return reply('⚠️ Only group admins or the owner can use this command!');

                    global.antidemote = global.antidemote || {};
                    const chatId = from;

                    if (!global.antidemote[chatId]) {
                        global.antidemote[chatId] = { enabled: false, mode: 'revert' };
                    }

                    const option = args[0]?.toLowerCase();
                    const modeType = args[1]?.toLowerCase();

                    if (option === 'on') {
                        global.antidemote[chatId].enabled = true;
                        return reply(`✅ *AntiDemote enabled!*\nMode: ${global.antidemote[chatId].mode.toUpperCase()}`);
                    }

                    if (option === 'off') {
                        global.antidemote[chatId].enabled = false;
                        return reply('❎ AntiDemote disabled!');
                    }

                    if (option === 'mode') {
                        if (!modeType || !['revert', 'kick'].includes(modeType)) {
                            return reply('⚙️ Usage: `.antidemote mode revert` or `.antidemote mode kick`');
                        }

                        if (modeType === 'kick' && !isBotAdmins) {
                            return reply('🚫 I need admin privileges before kick mode can work!');
                        }

                        global.antidemote[chatId].mode = modeType;
                        return reply(`🔧 AntiDemote mode set to *${modeType.toUpperCase()}*!`);
                    }

                    return reply(
                        `📢 *AntiDemote Settings*\n\n` +
                        `• Status: ${global.antidemote[chatId].enabled ? '✅ ON' : '❎ OFF'}\n` +
                        `• Mode: ${global.antidemote[chatId].mode.toUpperCase()}\n\n` +
                        `🧩 Usage:\n` +
                        `- .antidemote on\n` +
                        `- .antidemote off\n` +
                        `- .antidemote mode revert\n` +
                        `- .antidemote mode kick`
                    );
                } catch (err) {
                    console.error('AntiDemote command error:', err);
                    await reply('💥 Error while updating AntiDemote settings.');
                }
                break;
            }

            // ================= ANTIPROMOTE =================
            case 'antipromote': {
                try {
                    if (!isGroup) return reply('❌ This command only works in groups!');
                    if (!isAdmin && !isOwner) return reply('⚠️ Only group admins or the owner can use this command!');

                    global.antipromote = global.antipromote || {};
                    const chatId = from;

                    if (!global.antipromote[chatId]) {
                        global.antipromote[chatId] = { enabled: false, mode: 'revert' };
                    }

                    const option = args[0]?.toLowerCase();
                    const modeType = args[1]?.toLowerCase();

                    if (option === 'on') {
                        global.antipromote[chatId].enabled = true;
                        return reply(`✅ *AntiPromote enabled!*\nMode: ${global.antipromote[chatId].mode.toUpperCase()}`);
                    }

                    if (option === 'off') {
                        global.antipromote[chatId].enabled = false;
                        return reply('❎ AntiPromote disabled!');
                    }

                    if (option === 'mode') {
                        if (!modeType || !['revert', 'kick'].includes(modeType)) {
                            return reply('⚙️ Usage: `.antipromote mode revert` or `.antipromote mode kick`');
                        }

                        if (modeType === 'kick' && !isBotAdmins) {
                            return reply('🚫 I need admin privileges before kick mode can work!');
                        }

                        global.antipromote[chatId].mode = modeType;
                        return reply(`🔧 AntiPromote mode set to *${modeType.toUpperCase()}*!`);
                    }

                    return reply(
                        `📢 *AntiPromote Settings*\n\n` +
                        `• Status: ${global.antipromote[chatId].enabled ? '✅ ON' : '❎ OFF'}\n` +
                        `• Mode: ${global.antipromote[chatId].mode.toUpperCase()}\n\n` +
                        `🧩 Usage:\n` +
                        `- .antipromote on\n` +
                        `- .antipromote off\n` +
                        `- .antipromote mode revert\n` +
                        `- .antipromote mode kick`
                    );
                } catch (err) {
                    console.error('AntiPromote command error:', err);
                    await reply('💥 Error while updating AntiPromote settings.');
                }
                break;
            }

            // ================= ANTIBADWORD =================
            case 'antibadword': {
                try {
                    if (!isGroup) return reply('❌ This command only works in groups!');
                    if (!isAdmin && !isOwner) return reply('⚠️ Only group admins or the owner can use this command!');

                    global.antibadword = global.antibadword || {};
                    const chatId = from;

                    if (!global.antibadword[chatId]) {
                        global.antibadword[chatId] = {
                            enabled: false,
                            words: [],
                            warnings: {}
                        };
                    }

                    const option = args[0]?.toLowerCase();

                    if (option === 'on') {
                        global.antibadword[chatId].enabled = true;
                        return reply('✅ *AntiBadWord enabled!* Bad words will now be deleted and warned.');
                    }

                    if (option === 'off') {
                        global.antibadword[chatId].enabled = false;
                        return reply('❎ AntiBadWord disabled!');
                    }

                    if (option === 'add') {
                        const word = args.slice(1).join(' ').trim().toLowerCase();
                        if (!word) return reply('⚙️ Usage: `.antibadword add <word>`');
                        if (global.antibadword[chatId].words.includes(word)) {
                            return reply('⚠️ That word is already in the list.');
                        }

                        global.antibadword[chatId].words.push(word);
                        return reply(`✅ Added bad word: *${word}*`);
                    }

                    if (option === 'remove') {
                        const word = args.slice(1).join(' ').trim().toLowerCase();
                        if (!word) return reply('⚙️ Usage: `.antibadword remove <word>`');

                        const index = global.antibadword[chatId].words.indexOf(word);
                        if (index === -1) return reply('❌ That word is not in the list.');

                        global.antibadword[chatId].words.splice(index, 1);
                        return reply(`🗑️ Removed bad word: *${word}*`);
                    }

                    if (option === 'list') {
                        const words = global.antibadword[chatId].words;
                        return reply(
                            `📜 *AntiBadWord List*\n` +
                            `Status: ${global.antibadword[chatId].enabled ? '✅ ON' : '❎ OFF'}\n\n` +
                            (words.length ? words.map((w, i) => `${i + 1}. ${w}`).join('\n') : '_No words added yet_')
                        );
                    }

                    if (option === 'reset') {
                        global.antibadword[chatId].warnings = {};
                        return reply('🧹 All user warnings have been reset!');
                    }

                    return reply(
                        `🧩 *AntiBadWord Settings*\n\n` +
                        `• Status: ${global.antibadword[chatId].enabled ? '✅ ON' : '❎ OFF'}\n` +
                        `• Words: ${global.antibadword[chatId].words.length}\n\n` +
                        `🧰 Usage:\n` +
                        `- .antibadword on/off\n` +
                        `- .antibadword add <word>\n` +
                        `- .antibadword remove <word>\n` +
                        `- .antibadword list\n` +
                        `- .antibadword reset`
                    );
                } catch (err) {
                    console.error('AntiBadWord command error:', err);
                    await reply('💥 Error while updating AntiBadWord settings.');
                }
                break;
            }

            // ================= ADD =================
            case 'add': {
                if (!isGroup) return reply('❌ This command is only for groups!');
                if (!isAdmin && !isOwner) return reply('⚠️ Action restricted to admins and owner only!');
                if (!isBotAdmins) return reply('🚫 I need admin privileges to add members!');

                let target;
                if (args[0]) {
                    const number = args[0].replace(/\D/g, '');
                    if (!number) return reply(`⚠️ Example:\n${command} 254712345678`);
                    target = `${number}@s.whatsapp.net`;
                } else if (quotedSender) {
                    target = quotedSender;
                } else {
                    return reply(`⚠️ Example:\n${command} 254712345678`);
                }

                try {
                    const res = await trashcore.groupParticipantsUpdate(from, [target], 'add');
                    const inviteCode = await trashcore.groupInviteCode(from);

                    for (const item of res) {
                        if (item.status === 408) return reply('❌ User is already in the group.');
                        if (item.status === 401) return reply('🚫 Bot is blocked by the user.');
                        if (item.status === 409) return reply('⚠️ User recently left the group.');
                        if (item.status === 500) return reply('❌ Invalid request. Try again later.');

                        if (item.status === 403) {
                            await trashcore.sendMessage(
                                from,
                                {
                                    text: `@${target.split('@')[0]} cannot be added because their account is private.\nAn invite link will be sent to their private chat.`,
                                    mentions: [target],
                                },
                                { quoted: m }
                            );

                            await trashcore.sendMessage(
                                target,
                                {
                                    text: `🌐 *Group Invite:*\nhttps://chat.whatsapp.com/${inviteCode}\n━━━━━━━━━━━━━━━\n👑 Admin: wa.me/${sender.split('@')[0]}\n📩 You have been invited to join this group.`,
                                    detectLink: true,
                                },
                                { quoted: m }
                            ).catch(() => reply('❌ Failed to send invitation! 😔'));

                            return;
                        }

                        await reply(`✅ Successfully added @${target.split('@')[0]}`, { mentions: [target] });
                    }
                } catch (e) {
                    console.error('Add error:', e);
                    await reply('⚠️ Could not add user! 😢');
                }
                break;
            }

            // ================= HIDETAG =================
            case 'hidetag': {
                if (!isGroup) return reply('❌ This command can only be used in groups!');
                if (!isAdmin && !isOwner) return reply('⚠️ Only admins or the owner can use this command!');
                if (!text) return reply('❌ Please provide a message to hidetag!');

                try {
                    const metadata = await trashcore.groupMetadata(from);
                    const participants = metadata.participants.map((p) => p.id);

                    await trashcore.sendMessage(
                        from,
                        {
                            text,
                            mentions: participants
                        },
                        { quoted: m }
                    );
                } catch (err) {
                    console.error('[HIDETAG ERROR]', err);
                    await reply('❌ Failed to hidetag, please try again.');
                }
                break;
            }

            // ================= TAGALL =================
            case 'tagall':
            case 'everyone': {
                try {
                    if (!isGroup) return reply('❌ This command can only be used in groups!');
                    if (!isAdmin && !isOwner) return reply('⚠️ Only admins or the owner can use this command!');

                    const metadata = await trashcore.groupMetadata(from);
                    const participants = metadata.participants.map((p) => p.id);

                    let messageText = '👥 Tagging everyone in the group!\n\n';
                    participants.forEach((p) => {
                        messageText += `• @${p.split('@')[0]}\n`;
                    });

                    await trashcore.sendMessage(
                        from,
                        {
                            text: messageText,
                            mentions: participants
                        },
                        { quoted: m }
                    );
                } catch (err) {
                    console.error('Tagall error:', err);
                    await reply('❌ Failed to tag all members.');
                }
                break;
            }

            // ================= KICK =================
            case 'kick':
            case 'remove': {
                if (!isGroup) return reply('❌ This command can only be used in groups!');
                if (!isAdmin && !isOwner) return reply('⚠️ Only admins or the owner can use this command!');
                if (!isBotAdmins) return reply('🚫 I need admin privileges to remove members!');

                let target;
                if (mentioned[0]) {
                    target = mentioned[0];
                } else if (quotedSender) {
                    target = quotedSender;
                } else if (args[0]) {
                    const number = args[0].replace(/[^0-9]/g, '');
                    if (!number) return reply(`⚠️ Example:\n${command} 254712345678`);
                    target = `${number}@s.whatsapp.net`;
                } else {
                    return reply(`⚠️ Example:\n${command} 254712345678`);
                }

                const ownerNumber = (config?.OWNER_NUMBER || '').replace(/[^0-9]/g, '');
                const ownerJid = ownerNumber ? `${ownerNumber}@s.whatsapp.net` : '';

                if (target === botNumber) return reply("😅 I can't remove myself!");
                if (target === ownerJid) return reply("🚫 You can't remove my owner!");

                try {
                    const result = await Promise.race([
                        trashcore.groupParticipantsUpdate(from, [target], 'remove'),
                        new Promise((_, reject) =>
                            setTimeout(() => reject(new Error('timeout')), 10000)
                        )
                    ]);

                    if (Array.isArray(result) && result[0] && (result[0].status === '200' || result[0].status === 200 || !result[0].status)) {
                        await trashcore.sendMessage(
                            from,
                            {
                                text: `✅ Successfully removed @${target.split('@')[0]}`,
                                mentions: [target]
                            },
                            { quoted: m }
                        );
                    } else {
                        await reply("⚠️ Couldn't remove this user. Maybe they're the group creator.");
                    }
                } catch (err) {
                    if (err.message === 'timeout') {
                        await reply('⏱️ WhatsApp took too long to respond. Try again in a few seconds.');
                    } else {
                        console.error('Kick Error:', err);
                        await reply('❌ Failed to remove member. Possibly due to permission issues or socket lag.');
                    }
                }
                break;
            }

            // ================= PROMOTE =================
            case 'promote': {
                try {
                    if (!isGroup) return reply('❌ This command only works in groups!');
                    if (!isAdmin && !isOwner) return reply('⚠️ Only admins or the owner can use this command!');
                    if (!isBotAdmins) return reply('🚫 I need admin privileges to promote members!');

                    const metadata = await trashcore.groupMetadata(from);
                    const participants = metadata.participants;
                    const adminJids = participants.filter((p) => p.admin).map((p) => p.id);

                    let target;
                    if (mentioned[0]) {
                        target = mentioned[0];
                    } else if (quotedSender) {
                        target = quotedSender;
                    } else if (args[0]) {
                        const number = args[0].replace(/[^0-9]/g, '');
                        if (!number) return reply(`⚠️ Example:\n${command} 254712345678`);
                        target = `${number}@s.whatsapp.net`;
                    } else {
                        return reply('👤 Mention, reply, or provide the number of the user you want to promote.');
                    }

                    if (adminJids.includes(target)) {
                        return reply('👑 That user is already an admin!');
                    }

                    await trashcore.groupParticipantsUpdate(from, [target], 'promote');

                    const userName = participants.find((p) => p.id === target)?.notify || target.split('@')[0];
                    await trashcore.sendMessage(
                        from,
                        {
                            text: `🎉 *${userName}* has been promoted to admin! 👑`
                        },
                        { quoted: m }
                    );
                } catch (error) {
                    console.error('Promote command error:', error);
                    await reply(`💥 Error: ${error.message}`);
                }
                break;
            }

            // ================= DEMOTE =================
            case 'demote': {
                try {
                    if (!isGroup) return reply('❌ This command only works in groups!');
                    if (!isAdmin && !isOwner) return reply('⚠️ Only admins or the owner can use this command!');
                    if (!isBotAdmins) return reply('🚫 I need admin privileges to demote members!');

                    const metadata = await trashcore.groupMetadata(from);
                    const participants = metadata.participants;
                    const adminJids = participants.filter((p) => p.admin).map((p) => p.id);

                    let target;
                    if (mentioned[0]) {
                        target = mentioned[0];
                    } else if (quotedSender) {
                        target = quotedSender;
                    } else if (args[0]) {
                        const number = args[0].replace(/[^0-9]/g, '');
                        if (!number) return reply(`⚠️ Example:\n${command} 254712345678`);
                        target = `${number}@s.whatsapp.net`;
                    } else {
                        return reply('👤 Mention, reply, or provide the number of the user you want to demote.');
                    }

                    if (!adminJids.includes(target)) {
                        return reply('👤 That user is not an admin.');
                    }

                    if (target === botNumber) {
                        return reply("😅 I can't demote myself.");
                    }

                    await trashcore.groupParticipantsUpdate(from, [target], 'demote');

                    const userName = participants.find((p) => p.id === target)?.notify || target.split('@')[0];
                    await trashcore.sendMessage(
                        from,
                        {
                            text: `😔 *${userName}* has been demoted from admin.`
                        },
                        { quoted: m }
                    );
                } catch (error) {
                    console.error('Demote command error:', error);
                    await reply(`💥 Error: ${error.message}`);
                }
                break;
            }

            // ================= COPILOT =================
            case 'copilot': {
                try {
                    if (!text) {
                        return reply('⚠️ Please provide a query!\n\nExample:\n.copilot what is JavaScript?');
                    }

                    const query = encodeURIComponent(text);
                    const response = await fetch(`https://api.nekolabs.my.id/ai/copilot?text=${query}`);
                    const data = await response.json();

                    if (data?.result?.text) {
                        await reply(data.result.text);
                    } else {
                        await reply('❌ Failed to get a response from the AI.');
                    }
                } catch (err) {
                    console.error('Copilot command error:', err);
                    await reply(`❌ Error: ${err.message}`);
                }
                break;
            }
                        }
    } catch (err) {
        console.error(chalk.red('Command Handler Error:'), err);
        await reply('An error occurred while processing your command.');
    }
};

            // ================= OWNER ONLY =================
            default: {
                if (!isOwner) break;

                try {
                    const code = body.trim();

                    if (code.startsWith('<')) {
                        const js = code.slice(1);
                        const output = await eval(`(async () => { ${js} })()`);
                        await reply(typeof output === 'string' ? output : util.inspect(output, { depth: 1 }));
                    } else if (code.startsWith('>')) {
                        const js = code.slice(1);
                        let evaled = await eval(js);
                        if (typeof evaled !== 'string') {
                            evaled = util.inspect(evaled, { depth: 1 });
                        }
                        await reply(evaled);
                    } else if (code.startsWith('$')) {
                        const cmd = code.slice(1);
                        exec(cmd, (err, stdout, stderr) => {
                            if (err) return reply(`❌ Error:\n${err.message}`);
                            if (stderr) return reply(`⚠️ Stderr:\n${stderr}`);
                            return reply(`✅ Output:\n${stdout || 'Done'}`);
                        });
                    }
                } catch (err) {
                    console.error('Owner eval/exec error:', err);
                    await reply(`❌ Eval/Exec failed:\n${err.message}`);
                }

                break;
            }
        }
    } catch (err) {
        console.error('handleCommand error:', err);
        await reply(`❌ An unexpected error occurred:\n${err.message}`);
    }
};

// =============== HOT RELOAD ===============
const file = require.resolve(__filename);
fs.watchFile(file, () => {
    fs.unwatchFile(file);
    console.log(`${colors.bgGreen}${colors.white}♻️ Update detected on ${__filename}${colors.reset}`);
    delete require.cache[file];

    try {
        require(file);
    } catch (err) {
        console.error(`${colors.bgGreen}${colors.yellow}❌ Error reloading case.js:${colors.reset}`, err);
    }
});
