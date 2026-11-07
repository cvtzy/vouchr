// vouch bot for yapin.gg · bun + yapin.js + supabase (plain REST, no extra deps)
import os from 'node:os';
import { Client, Events, Intents, EmbedBuilder } from 'yapin.js';

const env = process.env;
for (const k of ['YAPIN_TOKEN', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY'])
  if (!env[k]) throw new Error(`missing ${k} in .env`);

const VERSION = env.VERSION ?? 'unset';
const COLOR = '#000000';
const STICK_DELAY = 2500; // ms of quiet before the sticky hops back to the bottom
const SLASH = new Set(['help', 'setup']); // the only commands usable with "/"
const VOUCH = /^\+(?:vouch|vch|v)(?=\s|$)\s*([\s\S]*)$/i;

// ───────────────────────── supabase ─────────────────────────
const REST = env.SUPABASE_URL!.replace(/\/+$/, '') + '/rest/v1';
const enc = encodeURIComponent;

async function sb(path: string, init: RequestInit & { prefer?: string } = {}) {
  const { prefer, ...rest } = init;
  const res = await fetch(REST + path, {
    ...rest,
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY!,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {}),
    },
  });
  if (!res.ok) throw new Error(`supabase ${res.status}: ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

type Guild = { server_id: string; channel_id: string | null; sticky_id: string | null; vouch_count: number };
const guilds = new Map<string, Guild | null>(); // cache, null = server never set up

async function getGuild(id: string): Promise<Guild | null> {
  if (guilds.has(id)) return guilds.get(id) ?? null;
  const rows = await sb(`/guilds?server_id=eq.${enc(id)}&select=*&limit=1`);
  const g: Guild | null = rows?.[0] ?? null;
  guilds.set(id, g);
  return g;
}

const saveSticky = (g: Guild, id: string) => {
  g.sticky_id = id;
  return sb(`/guilds?server_id=eq.${enc(g.server_id)}`, { method: 'PATCH', body: JSON.stringify({ sticky_id: id }) }).catch((e) =>
    console.error('[db]', e),
  );
};

// ───────────────────────── bot ─────────────────────────
const client = new Client({
  prefixes: ['/', '.'],
  intents: [Intents.Messages],
  presence: { status: 'online', activity: '+vouch · /help' },
});

const card = () => new EmbedBuilder().setColor(COLOR);
const say = (channelId: string, payload: any): Promise<any> => client.send(channelId, payload) as any;

async function flash(channelId: string, text: string) {
  const sent = await say(channelId, text).catch(() => null);
  if (sent) setTimeout(() => sent.delete().catch(() => {}), 5000);
}

// one job at a time per server, so vouches and sticky never race
const queues = new Map<string, Promise<unknown>>();
const enqueue = (id: string, fn: () => Promise<unknown>) => {
  const next = (queues.get(id) ?? Promise.resolve()).then(fn).catch((e) => console.error('[job]', e));
  queues.set(id, next);
  return next;
};

// ───────────────────────── sticky ─────────────────────────
const stickies = new Map<string, any>(); // serverId -> last sticky Message
const timers = new Map<string, ReturnType<typeof setTimeout>>();

async function stick(g: Guild) {
  const channelId = g.channel_id!;
  const old = stickies.get(g.server_id);
  const fresh = await say(channelId, { embeds: [card().setDescription(`total vouches: **${g.vouch_count}**`)] });
  if (!fresh?.id) return;
  stickies.set(g.server_id, fresh);
  if (old) await old.delete().catch(() => {});
  else if (g.sticky_id) {
    // first stick after a restart: remove the sticky we left behind
    try {
      const ch: any = await client.channels.fetch(channelId);
      const m: any = await ch.messages.fetch(g.sticky_id);
      await m.delete();
    } catch {}
  }
  void saveSticky(g, fresh.id);
}

// someone chatted in the vouch channel: hop the sticky back to the bottom once it goes quiet
function schedule(g: Guild) {
  clearTimeout(timers.get(g.server_id));
  timers.set(
    g.server_id,
    setTimeout(() => enqueue(g.server_id, () => stick(g)), STICK_DELAY),
  );
}

// ───────────────────────── vouching ─────────────────────────
async function vouch(m: any, g: Guild, text: string) {
  const ch = g.channel_id!;
  if (!text) return flash(ch, '`+vouch @user reason`: say what you are vouching for');

  try {
    await m.delete();
  } catch {
    return flash(ch, 'i need the **manage messages** permission to post vouches');
  }

  const avatar = m.author.avatarURL?.();
  const sent = await say(ch, {
    content: '+1 vouch!',
    embeds: [
      card()
        .setAuthor({ name: `${m.author.displayName} (@${m.author.username})`, iconURL: avatar || undefined })
        .setDescription(text),
    ],
  });
  sent?.react?.('✅')?.catch?.(() => {});

  try {
    const n = await sb('/rpc/add_vouch', {
      method: 'POST',
      body: JSON.stringify({ p_server: g.server_id, p_author: m.authorId, p_content: text }),
    });
    if (typeof n === 'number') g.vouch_count = n;
  } catch (e) {
    console.error('[db]', e);
  }
  await stick(g);
}

client.on(Events.MessageCreate, async (m: any) => {
  try {
    if (!m.serverId) return;
    const g = await getGuild(m.serverId);
    if (!g?.channel_id || m.channelId !== g.channel_id) return;

    const hit = VOUCH.exec((m.content ?? '').trim());
    if (!hit) return schedule(g);

    clearTimeout(timers.get(g.server_id));
    enqueue(g.server_id, () => vouch(m, g, hit[1].trim()));
  } catch (e) {
    console.error('[msg]', e);
  }
});

// ───────────────────────── commands ─────────────────────────
// "/" only works for /help and /setup; everything else is "." only
client.commands.use(async (ctx: any, next: any) => {
  if (ctx.prefix === '/' && !SLASH.has(ctx.command.name)) return;
  await next();
});

client.commands.register({
  name: 'help',
  description: 'how the vouch bot works',
  run: (ctx: any) =>
    ctx.reply({
      embeds: [
        card()
          .setTitle('vouch')
          .setDescription(
            [
              '`+vouch <text>` · `+vch` · `+v`  leave a vouch',
              '`/setup [#channel]`  set the vouch channel',
              '`.ping`  latency, specs, server info',
              '`.version` · `.v` · `.vers`  version',
            ].join('\n'),
          ),
      ],
    }),
});

client.commands.register({
  name: 'setup',
  description: 'pick the channel vouches go in',
  serverOnly: true,
  permissions: ['manage_server'], // server owner always passes
  options: [{ name: 'channel', type: 'channel', channelTypes: ['text'], default: (ctx: any) => ctx.channel, description: 'defaults to this channel' }],
  async run(ctx: any) {
    const ch = ctx.values.channel;
    const sid = ctx.server.id;
    const prev = await getGuild(sid);

    const rows = await sb('/guilds?on_conflict=server_id', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=representation',
      body: JSON.stringify({ server_id: sid, channel_id: ch.id, sticky_id: null }),
    });
    const g: Guild = rows[0];

    // pull the old sticky out of the previous channel
    const old = stickies.get(sid);
    stickies.delete(sid);
    if (old) await old.delete().catch(() => {});
    else if (prev?.channel_id && prev.sticky_id) {
      try {
        const oc: any = await client.channels.fetch(prev.channel_id);
        await (await oc.messages.fetch(prev.sticky_id)).delete();
      } catch {}
    }
    guilds.set(sid, g);

    await ctx.reply({ embeds: [card().setDescription(`vouches are live in ${ch}\npost \`+vouch @user reason\` there`)] });
    await enqueue(sid, () => stick(g));
  },
});

client.commands.register({
  name: 'ping',
  description: 'latency and specs',
  register: false,
  async run(ctx: any) {
    const t0 = performance.now();
    const sent: any = await ctx.reply('pinging…');
    const rest = Math.round(performance.now() - t0);

    const t1 = performance.now();
    const db = await sb('/guilds?select=server_id&limit=1').then(() => `${Math.round(performance.now() - t1)}ms`).catch(() => 'err');

    const cpus = os.cpus();
    const cpu = (cpus[0]?.model ?? 'unknown').replace(/\((R|TM)\)|\bCPU\b|@.*$/g, '').replace(/\s+/g, ' ').trim();
    const mb = (b: number) => Math.round(b / 1048576);
    const gb = (b: number) => (b / 1073741824).toFixed(1);
    const g = await getGuild(ctx.server?.id ?? '').catch(() => null);

    const lines = [
      `**latency**  gateway \`${client.ping == null ? 'polling' : client.ping + 'ms'}\` · rest \`${rest}ms\` · db \`${db}\``,
      `**host**  \`${os.platform()} ${os.arch()}\` · \`${cpus.length} cores\` · load \`${os.loadavg()[0].toFixed(2)}\``,
      `**cpu**  \`${cpu}\``,
      `**memory**  bot \`${mb(process.memoryUsage().rss)} MB\` · system \`${gb(os.totalmem() - os.freemem())} / ${gb(os.totalmem())} GB\``,
      `**runtime**  bun \`${Bun.version}\` · up \`${uptime(client.uptime ?? process.uptime() * 1000)}\``,
      `**bot**  \`${client.servers.cache.size} servers\` · \`v${VERSION}\``,
    ];
    if (ctx.server)
      lines.push(`**server**  ${ctx.server.name} · \`${ctx.server.memberCount ?? '?'} members\` · \`${g?.vouch_count ?? 0} vouches\``);

    const payload = { content: null, embeds: [card().setTitle('pong').setDescription(lines.join('\n'))] };
    if (sent?.edit) await sent.edit(payload).catch(() => ctx.send(payload));
    else await ctx.send(payload);
  },
});

client.commands.register({
  name: 'version',
  aliases: ['v', 'vers'],
  description: 'bot version',
  register: false,
  run: (ctx: any) => ctx.reply({ embeds: [card().setDescription(`**vouch** · \`v${VERSION}\``)] }),
});

function uptime(ms: number) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
}

// ───────────────────────── boot ─────────────────────────
client.on(Events.Error, (e: any) => console.error('[yapin]', e));
process.on('SIGINT', async () => {
  await client.destroy();
  process.exit(0);
});

await client.login();
console.log(`vouch bot v${VERSION} online as ${client.user?.username}`);
