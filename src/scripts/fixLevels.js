const db = require('../database/db');
const { xpForLevel } = require('../utils/xp');

function run() {
    const rows = db.prepare(`SELECT * FROM levels`).all();
    let fixedCount = 0;

    for (const row of rows) {
        let correctLevel = 0;
        while (row.xp >= xpForLevel(correctLevel)) {
            correctLevel += 1;
        }

        if (correctLevel !== row.level) {
            db.prepare(`
                UPDATE levels SET level = ? WHERE guildId = ? AND userId = ?
            `).run(correctLevel, row.guildId, row.userId);

            console.log(`Fixed ${row.userId} in guild ${row.guildId}: level ${row.level} -> ${correctLevel} (xp: ${row.xp})`);
            fixedCount++;
        }
    }

    console.log(`\nDone. Fixed ${fixedCount} out of ${rows.length} user(s).`);
}

run();
