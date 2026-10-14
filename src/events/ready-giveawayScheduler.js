const { Events } = require('discord.js');
const db = require('../database/db');
const { endGiveaway } = require('../utils/giveaways');

const CHECK_INTERVAL_MS = 30 * 1000;

module.exports = {
    name: Events.ClientReady,
    once: true,
    execute(client) {
        let running = false;
        setInterval(async () => {
            if (running) return;
            running = true;
            try {
                const expired = db.prepare(`
                    SELECT * FROM giveaways
                    WHERE (ended = 0 AND endTime <= ?) OR (ended = 1 AND announced = 0)
                `).all(Date.now());

                for (const row of expired) {
                    await endGiveaway(client, row).catch((err) =>
                        console.error(`Failed to auto-end giveaway #${row.id}:`, err)
                    );
                }
            } catch (error) {
                console.error('Giveaway scheduler failed:', error);
            } finally {
                running = false;
            }
        }, CHECK_INTERVAL_MS);
    },
};
