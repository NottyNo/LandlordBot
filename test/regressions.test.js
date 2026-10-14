const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire, wrap } = require('node:module');
const { EventEmitter } = require('node:events');
const Database = require('better-sqlite3');

const quiet = { log() {}, warn() {}, error() {} };

// Load production modules with isolated dependencies; never open the bot's database or connect to Discord.
function load(file, mocks = {}, globals = {}) {
    const filename = path.resolve(__dirname, '..', file);
    const localRequire = createRequire(filename);
    const module = { exports: {} };
    const run = vm.runInNewContext(wrap(fs.readFileSync(filename, 'utf8')), {
        console: quiet, Date, Math, setTimeout, clearTimeout, setInterval, ...globals,
    }, { filename });
    run(module.exports, (id) => Object.hasOwn(mocks, id) ? mocks[id] : localRequire(id),
        module, filename, path.dirname(filename));
    return module.exports;
}

function initialize(db) {
    return load('src/database/db.js', {
        'better-sqlite3': function () { return db; },
        'node:fs': { existsSync: () => true },
    });
}

function database(t) {
    const db = new Database(':memory:');
    t.after(() => db.close());
    return initialize(db);
}

function giveaway(db, mocks = {}) {
    return load('src/utils/giveaways.js', { '../database/db': db, ...mocks });
}

function insertGiveaway(db) {
    const { lastInsertRowid: id } = db.prepare(`
        INSERT INTO giveaways (guildId, channelId, messageId, hostId, prize, endTime)
        VALUES ('g', 'c', 'm', 'host', 'Prize', 1)
    `).run();
    for (const userId of ['alice', 'bob', 'charlie']) {
        db.prepare('INSERT INTO giveaway_entries VALUES (?, ?, 0)').run(id, userId);
    }
    return db.prepare('SELECT * FROM giveaways WHERE id = ?').get(id);
}

test('database exports a usable connection and migrates old giveaways without replaying history', (t) => {
    const db = new Database(':memory:');
    t.after(() => db.close());
    db.exec('CREATE TABLE giveaways (id INTEGER PRIMARY KEY, ended INTEGER NOT NULL)');
    db.exec('INSERT INTO giveaways VALUES (1, 1), (2, 0)');
    assert.equal(initialize(db), db);
    assert.deepEqual(db.prepare('SELECT announced FROM giveaways ORDER BY id').all(), [
        { announced: 1 }, { announced: 0 },
    ]);
    db.exec('UPDATE giveaways SET ended = 1 WHERE id = 2');
    initialize(db);
    assert.equal(db.prepare('SELECT announced FROM giveaways WHERE id = 2').get().announced, 0);
});

test('concurrent messages preserve both XP awards for new and existing users', async (t) => {
    const db = database(t);
    const leveling = load('src/events/messageCreate-Leveling.js', { '../database/db': db });
    const member = { roles: { cache: new Map() } };
    const message = { author: { id: 'u', bot: false }, guild: { id: 'g', members: { fetch: async () => member } } };
    await Promise.all([leveling.execute(message), leveling.execute(message)]);
    const first = db.prepare('SELECT * FROM levels').get();
    assert.ok(first.xp >= 30 && first.xp <= 50);
    await Promise.all([leveling.execute(message), leveling.execute(message)]);
    const second = db.prepare('SELECT * FROM levels').get();
    assert.ok(second.xp - first.xp >= 30 && second.xp - first.xp <= 50);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM levels').get().n, 1);
});

test('first voice award calculates the level and later awards preserve message cooldown', async (t) => {
    const db = database(t);
    const now = Date.now();
    const voice = load('src/events/VoiceStateUpdate-VoiceXP.js', { '../database/db': db }, { Date: { now: () => now } });
    let announcements = 0;
    const member = {
        id: 'u', user: { bot: false }, roles: { cache: new Map() },
        guild: { channels: { cache: new Map([['1549377391648837652', { send: async () => announcements++ }]]) } },
    };
    const leave = () => voice.execute({ channelId: 'v', guild: { id: 'g' } }, { channelId: null, member });
    db.prepare('INSERT INTO voice_sessions VALUES (?, ?, ?)').run('g', 'u', now - 30 * 60000);
    await leave();
    assert.deepEqual(db.prepare('SELECT xp, level FROM levels').get(), { xp: 150, level: 1 });
    assert.equal(announcements, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM voice_sessions').get().n, 0);
    db.exec('UPDATE levels SET lastMessage = 123');
    db.prepare('INSERT INTO voice_sessions VALUES (?, ?, ?)').run('g', 'u', now - 60000);
    await leave();
    assert.deepEqual(db.prepare('SELECT xp, level, lastMessage FROM levels').get(), { xp: 155, level: 2, lastMessage: 123 });
});

test('level repair runs without importing the bot and fixes persisted levels', (t) => {
    const db = database(t);
    db.exec("INSERT INTO levels VALUES ('g', 'u', 150, 0, 0)");
    load('src/scripts/fixLevels.js', { '../database/db': db, '../index.js': undefined });
    assert.equal(db.prepare('SELECT level FROM levels').get().level, 1);
});

test('automod sends warning text as its only argument and tolerates disabled DMs', async (t) => {
    const db = database(t);
    const automod = load('src/events/messageCreate-Automod.js', {
        '../database/db': db, '../config/bannedWords.json': { words: ['blocked'] },
    });
    let received;
    let timeouts = 0;
    const message = {
        content: 'blocked', delete: async () => {}, client: { user: { id: 'bot' } },
        author: { id: 'u', tag: 'User', bot: false, send: async (...args) => { received = args; } },
        guild: { id: 'g', name: 'Guild', members: { fetch: async () => ({ timeout: async () => timeouts++ }) } },
    };
    await automod.execute(message);
    assert.equal(received.length, 1);
    assert.match(received[0], /You were warned.*Warning 1/);
    message.author.send = async () => { throw new Error('DM disabled'); };
    await automod.execute(message);
    await automod.execute(message);
    assert.equal(timeouts, 1);
});

test('welcome uses the existing GIF and removes the image reference on fallback', async (t) => {
    const db = database(t);
    db.exec("INSERT INTO guild_settings (guildId, welcomeChannelId) VALUES ('g', 'c')");
    const welcome = load('src/events/guildMemberAdd-welcome.js', { '../database/db': db });
    const sent = [];
    const channel = { send: async (payload) => {
        sent.push(payload.embeds[0].toJSON());
        if (payload.files) {
            assert.ok(fs.existsSync(payload.files[0].attachment));
            assert.match(payload.files[0].attachment, /welcome\.gif$/);
            throw new Error('Attachment failed');
        }
    } };
    await welcome.execute({ guild: { id: 'g', name: 'Guild', channels: { cache: new Map([['c', channel]]) } } });
    assert.equal(sent.length, 2);
    assert.equal(sent[0].image.url, 'attachment://welcome.gif');
    assert.equal(sent[1].image, undefined);
});

test('duration parser accepts complete whole units and rejects malformed or excessive durations', (t) => {
    const { parseDuration } = giveaway(database(t));
    for (const invalid of ['1.5h', '-1h', '1h junk', 'junk 1h', '', '0s', '366d', '9'.repeat(400) + 'd', null]) {
        assert.equal(parseDuration(invalid), null, String(invalid));
    }
    assert.equal(parseDuration(' 1D 12h 30m 10s '), 131410000);
    assert.equal(parseDuration('365d'), 365 * 86400000);
    assert.equal(parseDuration('10s'), 10000);
});

test('winner shuffle reaches every permutation equally and respects exclusions', (t) => {
    const db = database(t);
    const permutations = new Set();
    for (let first = 0; first < 3; first++) {
        for (let second = 0; second < 2; second++) {
            const draws = [first, second];
            const { pickWinners } = giveaway(db, { 'node:crypto': { randomInt: () => draws.shift() } });
            const input = ['a', 'b', 'c'];
            permutations.add(pickWinners(input, 3).join(''));
            assert.deepEqual(input, ['a', 'b', 'c']);
            assert.equal(draws.length, 0);
        }
    }
    assert.equal(permutations.size, 6);
    const { pickWinners } = giveaway(db);
    assert.equal(pickWinners(['a', 'b'], 9, ['a']).join(','), 'b');
    assert.equal(pickWinners([], 1).length, 0);
});

for (const stage of ['channel', 'fetch', 'edit', 'send']) {
    test(`giveaway retries ${stage} failures after reload without redrawing or duplicate concurrent sends`, async (t) => {
        const db = database(t);
        const row = insertGiveaway(db);
        let failing = true;
        let sends = 0;
        const fail = (at) => { if (failing && stage === at) throw new Error('Temporary failure'); };
        const channel = {
            guild: {},
            messages: { fetch: async () => { fail('fetch'); return { edit: async () => fail('edit') }; } },
            send: async () => { fail('send'); sends++; },
        };
        const client = { channels: { fetch: async () => { fail('channel'); return channel; } } };
        await assert.rejects(giveaway(db).endGiveaway(client, row), /Temporary failure/);
        const saved = db.prepare('SELECT * FROM giveaways WHERE id = ?').get(row.id);
        assert.equal(saved.ended, 1);
        assert.equal(saved.announced, 0);
        assert.equal(JSON.parse(saved.winners).length, 1);
        failing = false;
        const reloaded = giveaway(db, { 'node:crypto': { randomInt: () => { throw new Error('Must not redraw'); } } });
        await Promise.all([reloaded.endGiveaway(client, row), reloaded.endGiveaway(client, row)]);
        await reloaded.endGiveaway(client, row);
        assert.equal(sends, 1);
        assert.equal(db.prepare('SELECT announced FROM giveaways WHERE id = ?').get(row.id).announced, 1);
        assert.equal(db.prepare('SELECT winners FROM giveaways WHERE id = ?').get(row.id).winners, saved.winners);
    });
}

test('deleted giveaway messages do not prevent a result announcement', async (t) => {
    const db = database(t);
    const row = insertGiveaway(db);
    let sent = false;
    await giveaway(db).endGiveaway({ channels: { fetch: async () => ({
        guild: {},
        messages: { fetch: async () => { throw Object.assign(new Error('Deleted'), { code: 10008 }); } },
        send: async () => { sent = true; },
    }) } }, row);
    assert.equal(sent, true);
});

test('giveaway command rejects invalid durations before inserting data', async (t) => {
    const db = database(t);
    const command = load('src/commands/moderation/giveaway.js', {
        '../../database/db': db, '../../utils/giveaways': giveaway(db),
    });
    let response;
    await command.execute({
        options: {
            getSubcommand: () => 'create', getString: (name) => name === 'duration' ? '1.5h' : 'Prize',
            getInteger: () => null,
        },
        reply: async (payload) => { response = payload; },
    });
    assert.match(response.content, /Invalid duration/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM giveaways').get().n, 0);
});

test('giveaway commands protect pending winners and allow an explicit delivery retry', async (t) => {
    const db = database(t);
    const row = insertGiveaway(db);
    db.prepare('UPDATE giveaways SET ended = 1, winners = ? WHERE id = ?').run('["alice"]', row.id);
    let delivered = 0;
    const command = load('src/commands/moderation/giveaway.js', {
        '../../database/db': db,
        '../../utils/giveaways': { ...giveaway(db), endGiveaway: async () => { delivered++; } },
    });
    let subcommand = 'reroll';
    let response;
    const interaction = {
        guild: { id: 'g' }, client: {},
        options: { getSubcommand: () => subcommand, getInteger: (name) => name === 'giveaway_id' ? row.id : null },
        reply: async (payload) => { response = payload; },
        deferReply: async () => {}, editReply: async () => {},
    };
    await command.execute(interaction);
    assert.match(response.content, /still waiting to be announced/);
    assert.equal(db.prepare('SELECT winners FROM giveaways WHERE id = ?').get(row.id).winners, '["alice"]');
    subcommand = 'end';
    await command.execute(interaction);
    assert.equal(delivered, 1);
});

test('presence timer errors are logged instead of escaping', () => {
    let tick;
    let calls = 0;
    const errors = [];
    const ready = load('src/events/ready.js', { '../database/db': { prepare: () => ({ run() {} }) } }, {
        setInterval: (fn) => { tick = fn; }, console: { ...quiet, error: (...args) => errors.push(args) },
    });
    return ready.execute({
        user: { tag: 'Bot', setPresence() { if (++calls > 1) throw new Error('Disconnected'); } },
        guilds: { cache: new Map() },
    }).then(() => {
        assert.doesNotThrow(tick);
        assert.equal(errors.length, 1);
    });
});

test('spam warning expiry handles database errors without an uncaught timer exception', async (t) => {
    const db = database(t);
    let timer;
    const errors = [];
    const automod = load('src/events/messageCreate-Automod.js', {
        '../database/db': { prepare: (sql) => {
            if (sql.includes('DELETE FROM warns')) throw new Error('Database busy');
            return db.prepare(sql);
        } },
        '../config/bannedWords.json': { words: [] },
    }, { setTimeout: (fn) => { timer = fn; }, console: { ...quiet, error: (...args) => errors.push(args) } });
    const message = {
        content: 'hello', delete: async () => {}, client: { user: { id: 'bot' } },
        author: { id: 'u', bot: false, send: async () => {} },
        guild: { id: 'g', members: { fetch: async () => ({ timeout: async () => {} }) } },
    };
    for (let i = 0; i < 6; i++) await automod.execute(message);
    assert.doesNotThrow(timer);
    assert.equal(errors.length, 1);
});

test('scheduler retries pending early endings, catches query errors, and avoids overlapping runs', async (t) => {
    const db = database(t);
    const row = insertGiveaway(db);
    db.prepare('UPDATE giveaways SET ended = 1, endTime = ? WHERE id = ?').run(Date.now() + 60000, row.id);
    let tick;
    let calls = 0;
    let failQuery = true;
    let release;
    const scheduler = load('src/events/ready-giveawayScheduler.js', {
        '../database/db': { prepare: (sql) => { if (failQuery) throw new Error('Database busy'); return db.prepare(sql); } },
        '../utils/giveaways': { endGiveaway: async () => { calls++; await new Promise((resolve) => { release = resolve; }); } },
    }, { setInterval: (fn) => { tick = fn; } });
    scheduler.execute({});
    await tick();
    failQuery = false;
    const pending = tick();
    await tick();
    assert.equal(calls, 1);
    release();
    await pending;
});

test('event dispatcher catches synchronous and asynchronous event failures', async () => {
    const errors = [];
    let client;
    class Client extends EventEmitter {
        constructor() { super(); client = this; }
        login() { return Promise.resolve(); }
    }
    const eventDir = path.resolve(__dirname, '../src/events');
    load('src/index.js', {
        'node:fs': { readdirSync: (dir) => dir === eventDir ? ['sync.js', 'async.js'] : [] },
        'node:events': { EventEmitter: {} },
        'discord.js': { Client, Collection: Map, GatewayIntentBits: {} },
        undici: { Agent: class {}, setGlobalDispatcher() {} },
        './config/config.json': { token: 'unused' },
        [path.join(eventDir, 'sync.js')]: { name: 'sync', execute() { throw new Error('sync'); } },
        [path.join(eventDir, 'async.js')]: { name: 'async', once: true, async execute() { throw new Error('async'); } },
    }, { console: { ...quiet, error: (...args) => errors.push(args) } });
    client.emit('sync');
    client.emit('async');
    await new Promise(setImmediate);
    assert.equal(errors.length, 2);
    assert.equal(client.listenerCount('async'), 0);
});

test('background stats failures are handled for immediate and delayed updates', async () => {
    let timer;
    let fail = false;
    const errors = [];
    const stats = load('src/utils/statChannels.js', {
        '../database/db': { prepare: () => { if (fail) throw new Error('Database busy'); return { get: () => undefined }; } },
    }, { setTimeout: (fn) => { timer = fn; }, console: { ...quiet, error: (...args) => errors.push(args) } });
    stats.updateStatChannels({ id: 'g' });
    await new Promise(setImmediate);
    stats.updateStatChannels({ id: 'g' });
    fail = true;
    timer();
    stats.updateStatChannels({ id: 'other' });
    await new Promise(setImmediate);
    assert.equal(errors.length, 2);
});
