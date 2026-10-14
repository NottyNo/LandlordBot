const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const db = require('../database/db');
const { randomInt } = require('node:crypto');

function parseDuration(input) {
    if (typeof input !== 'string' || !/^(?:\d+\s*[dhms]\s*)+$/i.test(input.trim())) return null;
    const regex = /(\d+)\s*(d|h|m|s)/gi;
    let match;
    let totalMs = 0;

    while ((match = regex.exec(input)) !== null) {
        const value = parseInt(match[1], 10);
        const unit = match[2].toLowerCase();
        const multipliers = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
        totalMs += value * multipliers[unit];
    }

    return Number.isSafeInteger(totalMs) && totalMs > 0 && totalMs <= 365 * 86400000 ? totalMs : null;
}

function buildRequirements(options) {
    const requirements = {};

    if (options.role) requirements.roleId = options.role.id;
    if (options.minLevel) requirements.minLevel = options.minLevel;
    if (options.minMessagesToday) requirements.minMessagesToday = options.minMessagesToday;
    if (options.minAccountAgeDays) requirements.minAccountAgeDays = options.minAccountAgeDays;
    if (options.minServerAgeDays) requirements.minServerAgeDays = options.minServerAgeDays;

    return requirements;
}

function formatRequirements(requirements, guild) {
    const lines = [];

    if (requirements.roleId) {
        lines.push(`• Must have role <@&${requirements.roleId}>`);
    }
    if (requirements.minLevel) {
        lines.push(`• Must be at least **Level ${requirements.minLevel}**`);
    }
    if (requirements.minMessagesToday) {
        lines.push(`• Must have sent **${requirements.minMessagesToday}+ messages today**`);
    }
    if (requirements.minAccountAgeDays) {
        lines.push(`• Account must be **${requirements.minAccountAgeDays}+ days old**`);
    }
    if (requirements.minServerAgeDays) {
        lines.push(`• Must have been in the server **${requirements.minServerAgeDays}+ days**`);
    }

    return lines.length ? lines.join('\n') : '*No requirements — anyone can enter!*';
}

function checkRequirements(guild, member, requirements) {
    const failedReasons = [];

    if (requirements.roleId && !member.roles.cache.has(requirements.roleId)) {
        failedReasons.push(`To enter this giveaway, you need <@&${requirements.roleId}>.`);
    }

    if (requirements.minLevel) {
        const row = db.prepare(`SELECT level FROM levels WHERE guildId = ? AND userId = ?`).get(guild.id, member.id);
        const level = row?.level ?? 0;
        if (level < requirements.minLevel) {
            failedReasons.push(`You need to be at least Level ${requirements.minLevel} (you're Level ${level}).`);
        }
    }

    if (requirements.minMessagesToday) {
        const date = new Date().toISOString().slice(0, 10);
        const row = db.prepare(`
            SELECT count FROM daily_messages WHERE guildId = ? AND userId = ? AND date = ?
        `).get(guild.id, member.id, date);
        const count = row?.count ?? 0;
        if (count < requirements.minMessagesToday) {
            failedReasons.push(`You need to send ${requirements.minMessagesToday} messages today (you've sent ${count}).`);
        }
    }

    if (requirements.minAccountAgeDays) {
        const ageMs = Date.now() - member.user.createdTimestamp;
        const ageDays = ageMs / 86400000;
        if (ageDays < requirements.minAccountAgeDays) {
            failedReasons.push(`Your account needs to be at least ${requirements.minAccountAgeDays} days old.`);
        }
    }

    if (requirements.minServerAgeDays) {
        const ageMs = Date.now() - member.joinedTimestamp;
        const ageDays = ageMs / 86400000;
        if (ageDays < requirements.minServerAgeDays) {
            failedReasons.push(`You need to have been in this server for ${requirements.minServerAgeDays} days.`);
        }
    }

    return { eligible: failedReasons.length === 0, failedReasons };
}

function buildGiveawayComponents(giveawayId, ended = false) {
    const button = new ButtonBuilder()
        .setCustomId(`giveaway_enter_${giveawayId}`)
        .setLabel(ended ? 'Giveaway Ended' : '🎉 Enter Giveaway')
        .setStyle(ended ? ButtonStyle.Secondary : ButtonStyle.Primary)
        .setDisabled(ended);

    return [new ActionRowBuilder().addComponents(button)];
}

function buildGiveawayEmbed(row, guild, embedColor, ended = false) {
    const requirements = JSON.parse(row.requirements);
    const entryCount = db.prepare(`
        SELECT COUNT(*) AS count FROM giveaway_entries WHERE giveawayId = ?
    `).get(row.id).count;

    const embed = new EmbedBuilder()
        .setTitle(ended ? `🎉 Giveaway Ended: ${row.prize}` : `🎉 Giveaway: ${row.prize}`)
        .setColor(embedColor)
        .addFields(
            { name: 'Winners', value: `${row.winnerCount}`, inline: true },
            { name: 'Entries', value: `${entryCount}`, inline: true },
            {
                name: ended ? 'Ends' : 'Ends',
                value: `<t:${Math.floor(row.endTime / 1000)}:R>`,
                inline: true,
            },
            { name: 'Requirements', value: formatRequirements(requirements, guild) },
        )
        .setFooter({ text: `Giveaway ID: ${row.id} • Hosted by` })
        .setTimestamp(row.endTime);

    if (ended) {
        const winners = JSON.parse(row.winners);
        embed.addFields({
            name: 'Winner(s)',
            value: winners.length ? winners.map((id) => `<@${id}>`).join(', ') : 'No valid entries.',
        });
    }

    return embed;
}

function pickWinners(entryUserIds, count, exclude = []) {
    const pool = entryUserIds.filter((id) => !exclude.includes(id));
    for (let i = pool.length - 1; i > 0; i--) {
        const j = randomInt(i + 1);
        [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool.slice(0, count);
}

// shortcut: delivery locking is per process; use a database lease before running multiple bot processes.
const deliveries = new Map();

function endGiveaway(client, row) {
    if (deliveries.has(row.id)) return deliveries.get(row.id);

    const delivery = Promise.resolve().then(async () => {
        const current = db.transaction(() => {
            const saved = db.prepare('SELECT * FROM giveaways WHERE id = ?').get(row.id);
            if (!saved) throw new Error(`Giveaway #${row.id} not found`);
            if (!saved.ended) {
                const entries = db.prepare('SELECT userId FROM giveaway_entries WHERE giveawayId = ?')
                    .all(saved.id).map((entry) => entry.userId);
                saved.winners = JSON.stringify(pickWinners(entries, saved.winnerCount));
                db.prepare('UPDATE giveaways SET ended = 1, winners = ? WHERE id = ?')
                    .run(saved.winners, saved.id);
                saved.ended = 1;
            }
            return saved;
        })();
        if (current.announced) return;

        const channel = await client.channels.fetch(current.channelId);
        if (!channel) throw new Error(`Giveaway channel ${current.channelId} not found`);
        const message = current.messageId ? await channel.messages.fetch(current.messageId).catch((error) => {
            if (error.code === 10008) return null; // Deleted messages cannot be updated.
            throw error;
        }) : null;
        const embed = buildGiveawayEmbed(current, channel.guild, 0x2ecc71, true);
        if (message) {
            await message.edit({ embeds: [embed], components: buildGiveawayComponents(current.id, true) });
        }

        const winnerIds = JSON.parse(current.winners);
        // shortcut: a crash after send but before saving can duplicate the announcement; add delivery deduplication if needed.
        await channel.send(winnerIds.length
            ? `🎉 Congratulations ${winnerIds.map((id) => `<@${id}>`).join(', ')}! You won **${current.prize}**!`
            : `😔 No valid entries for **${current.prize}** — no winner could be picked.`);
        db.prepare('UPDATE giveaways SET announced = 1 WHERE id = ?').run(current.id);
    }).finally(() => deliveries.delete(row.id));

    deliveries.set(row.id, delivery);
    return delivery;
}

module.exports = {
    parseDuration,
    buildRequirements,
    formatRequirements,
    checkRequirements,
    buildGiveawayEmbed,
    buildGiveawayComponents,
    pickWinners,
    endGiveaway,
};
