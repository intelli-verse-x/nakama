// characters.js - Character System for QuizVerse v3.0
// RPCs: character_get_state, character_unlock, character_set_active

/**
 * Character System — Production-Ready
 *
 * Characters are cosmetic companions with XP bonuses.
 * Rule#7: Unlocking characters awards XP ONLY, never currency.
 *
 * Storage: collection="player_data", key="characters_{userId}_{gameId}"
 */

// ─── CHARACTER DEFINITIONS ──────────────────────────────────────────────────

// ─── CHARACTER DEFINITIONS (quizverse.gameset.v2 — 15 active characters) ────
// Removed: Gloop, Chronos, Phoenix, Sage (not in v2 gameset manifest)
// Added:   Quizzy_v1, Quizzy_v2 (v2 gameset variants)
var CHARACTER_DEFS = {
    Quizzy: {
        id: 'Quizzy',
        name: 'Quizzy',
        description: 'Your first quiz companion!',
        rarity: 'common',
        xpBonus: 0,
        unlockCondition: 'default',
        introVideoPath: 'Characters/Quizzy/intro.mp4',
        xpRewardOnUnlock: 0
    },
    Quizzy_v1: {
        id: 'Quizzy_v1',
        name: 'Quizzy V1',
        description: 'The original classic Quizzy design.',
        rarity: 'common',
        xpBonus: 0,
        unlockCondition: 'default',
        introVideoPath: 'Characters/Quizzy_v1/intro.mp4',
        xpRewardOnUnlock: 0
    },
    Quizzy_v2: {
        id: 'Quizzy_v2',
        name: 'Quizzy V2',
        description: 'The redesigned Quizzy with a fresh new look.',
        rarity: 'common',
        xpBonus: 0,
        unlockCondition: 'default',
        introVideoPath: 'Characters/Quizzy_v2/intro.mp4',
        xpRewardOnUnlock: 0
    },
    AUTOcurio: {
        id: 'AUTOcurio',
        name: 'AUTOcurio',
        description: 'A charming, hyper-curious bot who awakens in the human world with an insatiable desire to understand everything.',
        rarity: 'common',
        xpBonus: 0,
        unlockCondition: 'default',
        introVideoPath: 'Characters/AUTOcurio/intro.mp4',
        xpRewardOnUnlock: 0
    },
    Atlas: {
        id: 'Atlas',
        name: 'Atlas',
        description: 'The world explorer who loves geography.',
        rarity: 'rare',
        xpBonus: 5,
        unlockCondition: 'geography_master',
        introVideoPath: 'Characters/Atlas/intro.mp4',
        xpRewardOnUnlock: 100
    },
    Nova: {
        id: 'Nova',
        name: 'Nova',
        description: 'A science genius from the stars.',
        rarity: 'rare',
        xpBonus: 5,
        unlockCondition: 'science_master',
        introVideoPath: 'Characters/Nova/intro.mp4',
        xpRewardOnUnlock: 100
    },
    Dog: {
        id: 'Dog',
        name: 'Dog',
        description: 'A cute, loyal puppy character with floppy ears and a wagging tail.',
        rarity: 'rare',
        xpBonus: 5,
        unlockCondition: 'dashing_debut',
        introVideoPath: 'Characters/Dog/intro.mp4',
        xpRewardOnUnlock: 100
    },
    Sparky: {
        id: 'Sparky',
        name: 'Sparky',
        description: 'An energetic lightning-bolt character radiating electric energy.',
        rarity: 'rare',
        xpBonus: 5,
        unlockCondition: 'speed_demon',
        introVideoPath: 'Characters/Sparky/intro.mp4',
        xpRewardOnUnlock: 100
    },
    Echo: {
        id: 'Echo',
        name: 'Echo',
        description: 'A musical character with oversized headphones and sound wave aura.',
        rarity: 'rare',
        xpBonus: 5,
        unlockCondition: 'music_master',
        introVideoPath: 'Characters/Echo/intro.mp4',
        xpRewardOnUnlock: 100
    },
    Professor: {
        id: 'Professor',
        name: 'Professor',
        description: 'A wise owl professor with round glasses and a book.',
        rarity: 'rare',
        xpBonus: 5,
        unlockCondition: 'quiz_warrior',
        introVideoPath: 'Characters/Professor/intro.mp4',
        xpRewardOnUnlock: 100
    },
    Pixel: {
        id: 'Pixel',
        name: 'Pixel',
        description: 'A retro pixel-art character made of visible square pixels.',
        rarity: 'rare',
        xpBonus: 5,
        unlockCondition: 'social_butterfly',
        introVideoPath: 'Characters/Pixel/intro.mp4',
        xpRewardOnUnlock: 100
    },
    Bear: {
        id: 'Bear',
        name: 'Bear',
        description: 'A strong, friendly bear character representing dedication.',
        rarity: 'epic',
        xpBonus: 10,
        unlockCondition: 'badge_hunter',
        introVideoPath: 'Characters/Bear/intro.mp4',
        xpRewardOnUnlock: 250
    },
    Duck: {
        id: 'Duck',
        name: 'Duck',
        description: 'A cute rubber duck character with a quirky personality.',
        rarity: 'epic',
        xpBonus: 10,
        unlockCondition: 'omniscient',
        introVideoPath: 'Characters/Duck/intro.mp4',
        xpRewardOnUnlock: 250
    },
    Luna: {
        id: 'Luna',
        name: 'Luna',
        description: 'A mystical crescent moon character with a starry aura.',
        rarity: 'epic',
        xpBonus: 10,
        unlockCondition: 'night_owl',
        introVideoPath: 'Characters/Luna/intro.mp4',
        xpRewardOnUnlock: 250
    },
    IX: {
        id: 'IX',
        name: 'IX',
        description: 'IntelliVerse X ultimate character — futuristic AI entity.',
        rarity: 'legendary',
        xpBonus: 15,
        unlockCondition: 'ultimate_player',
        introVideoPath: 'Characters/IX/intro.mp4',
        xpRewardOnUnlock: 500
    }
};

var CHAR_STORAGE_COLLECTION = 'player_data';

// ─── CANONICAL GAME ID (BUG FIX 2026-08-06) ─────────────────────────────────
// Character docs were keyed by the RAW client game_id (Unity sends the
// QuizVerse UUID), splitting character state per id spelling. Canonicalize
// to 'quizverse' with legacy-key fallback + migrate-on-write.
var CHAR_QUIZVERSE_UUID = '126bf539-dae2-4bcf-964d-316c0fa1f92b';
var CHAR_CANONICAL_GAME_ID = 'quizverse';

function charCanonicalGameId(gameId) {
    if (!gameId) return CHAR_CANONICAL_GAME_ID;
    var g = String(gameId);
    if (g === CHAR_QUIZVERSE_UUID || g === 'quizverse' ||
        g === 'quiz-verse' || g === 'QuizVerse') {
        return CHAR_CANONICAL_GAME_ID;
    }
    return g;
}

// Badge progress collection (mirrors badges/badges.js) — used for the
// server-side unlock-condition validation + the badge→character chain.
var CHAR_BADGE_PROGRESS_COLLECTION = 'badge_progress';

/**
 * Read the caller's badge progress doc (canonical badge-space) and return
 * the set of unlocked badge_ids. Empty set on any failure — callers decide
 * whether that means "reject" (validation) or "skip" (best-effort).
 */
function charReadUnlockedBadgeIds(nk, logger, userId) {
    var unlocked = {};
    try {
        var recs = nk.storageRead([{
            collection: CHAR_BADGE_PROGRESS_COLLECTION,
            key: 'progress_' + userId + '_' + CHAR_CANONICAL_GAME_ID,
            userId: userId
        }]);
        if (recs && recs.length > 0 && recs[0].value) {
            var progress = recs[0].value;
            for (var badgeId in progress) {
                if (progress.hasOwnProperty(badgeId) && progress[badgeId].unlocked) {
                    unlocked[badgeId] = true;
                }
            }
        }
    } catch (e) {
        logger.warn('[Characters] Badge progress read failed: ' + e.message);
    }
    return unlocked;
}

// ─── HELPERS ────────────────────────────────────────────────────────────────

function charStorageKey(userId, gameId) {
    return 'characters_' + userId + '_' + gameId;
}

function readCharacterData(nk, logger, userId, gameId) {
    // Canonical key first, legacy raw-gameId key as fallback (migrate-on-write)
    var canonGameId = charCanonicalGameId(gameId);
    try {
        var records = nk.storageRead([{
            collection: CHAR_STORAGE_COLLECTION,
            key: charStorageKey(userId, canonGameId),
            userId: userId
        }]);
        if (records && records.length > 0 && records[0].value) {
            return records[0].value;
        }
    } catch (err) {
        logger.warn('[Characters] Storage read failed: ' + err.message);
    }
    if (String(gameId || '') !== canonGameId) {
        try {
            var legacy = nk.storageRead([{
                collection: CHAR_STORAGE_COLLECTION,
                key: charStorageKey(userId, gameId),
                userId: userId
            }]);
            if (legacy && legacy.length > 0 && legacy[0].value) {
                logger.info('[Characters] Migrating legacy doc ' +
                    charStorageKey(userId, gameId) + ' -> ' +
                    charStorageKey(userId, canonGameId));
                return legacy[0].value;
            }
        } catch (err2) { /* no legacy doc */ }
    }
    return null;
}

function writeCharacterData(nk, logger, userId, gameId, data) {
    try {
        nk.storageWrite([{
            collection: CHAR_STORAGE_COLLECTION,
            key: charStorageKey(userId, charCanonicalGameId(gameId)),
            userId: userId,
            value: data,
            permissionRead: 1,
            permissionWrite: 0
        }]);
        return true;
    } catch (err) {
        logger.error('[Characters] Storage write failed: ' + err.message);
        return false;
    }
}

function initCharacterData(userId) {
    var now = new Date().toISOString();
    return {
        activeCharacter: 'Quizzy',
        unlockedCharacters: {
            Quizzy:     { unlockedAt: now },
            Quizzy_v1:  { unlockedAt: now },
            Quizzy_v2:  { unlockedAt: now },
            AUTOcurio:  { unlockedAt: now }
        },
        totalXpFromUnlocks: 0,
        createdAt: now,
        updatedAt: now
    };
}

function charErrorResponse(msg) {
    return JSON.stringify({ success: false, error: msg });
}

function charValidatePayload(payload) {
    if (!payload || payload === '') return {};
    try {
        return JSON.parse(payload);
    } catch (err) {
        return null;
    }
}

// ─── RPC: character_get_state ───────────────────────────────────────────────

function rpcCharacterGetState(ctx, logger, nk, payload) {
    if (!ctx.userId) return charErrorResponse('User not authenticated');

    var data = charValidatePayload(payload);
    if (data === null) return charErrorResponse('Invalid JSON payload');

    // Accept both camelCase (gameId) and snake_case (game_id) for robustness
    var gameId = data.gameId || data.game_id || 'quizverse';
    var charData = readCharacterData(nk, logger, ctx.userId, gameId);

    if (!charData) {
        charData = initCharacterData(ctx.userId);
        writeCharacterData(nk, logger, ctx.userId, gameId, charData);
    }

    // Auto-migrate: grant default characters to existing players
    var dirty = false;
    for (var defId in CHARACTER_DEFS) {
        if (CHARACTER_DEFS[defId].unlockCondition === 'default') {
            if (!charData.unlockedCharacters[defId]) {
                charData.unlockedCharacters[defId] = { unlockedAt: new Date().toISOString() };
                dirty = true;
            }
        }
    }
    if (dirty) {
        charData.updatedAt = new Date().toISOString();
        writeCharacterData(nk, logger, ctx.userId, gameId, charData);
    }

    // Build characters array with unlock status
    var characters = [];
    for (var charId in CHARACTER_DEFS) {
        var def = CHARACTER_DEFS[charId];
        var isUnlocked = charData.unlockedCharacters && charData.unlockedCharacters[charId];

        characters.push({
            id: def.id,
            name: def.name,
            description: def.description,
            rarity: def.rarity,
            xpBonus: def.xpBonus,
            unlocked: !!isUnlocked,
            unlockedAt: isUnlocked ? charData.unlockedCharacters[charId].unlockedAt : null,
            unlockCondition: isUnlocked ? null : def.unlockCondition,
            introVideoPath: def.introVideoPath
        });
    }

    return JSON.stringify({
        success: true,
        userId: ctx.userId,
        gameId: gameId,
        activeCharacter: charData.activeCharacter,
        characters: characters,
        totalUnlocked: Object.keys(charData.unlockedCharacters || {}).length,
        totalCharacters: Object.keys(CHARACTER_DEFS).length,
        totalXpFromUnlocks: charData.totalXpFromUnlocks || 0,
        timestamp: new Date().toISOString()
    });
}

// ─── RPC: character_unlock ──────────────────────────────────────────────────

function rpcCharacterUnlock(ctx, logger, nk, payload) {
    if (!ctx.userId) return charErrorResponse('User not authenticated');

    var data = charValidatePayload(payload);
    if (data === null) return charErrorResponse('Invalid JSON payload');

    var gameId = data.gameId || data.game_id || 'quizverse';
    var characterId = data.characterId;

    if (!characterId) return charErrorResponse('Missing required field: characterId');

    var def = CHARACTER_DEFS[characterId];
    if (!def) return charErrorResponse('Character not found: ' + characterId);

    var charData = readCharacterData(nk, logger, ctx.userId, gameId);
    if (!charData) {
        charData = initCharacterData(ctx.userId);
    }

    // Check if already unlocked
    if (charData.unlockedCharacters && charData.unlockedCharacters[characterId]) {
        return JSON.stringify({
            success: false,
            error: 'already_unlocked',
            characterId: characterId,
            unlockedAt: charData.unlockedCharacters[characterId].unlockedAt
        });
    }

    // Server-side condition validation (BUG FIX 2026-08-06).
    // Was: "the server trusts that the client has verified the condition" —
    // which both allowed cheating and silently dropped legit unlocks whenever
    // the client chain broke. Now: non-default characters require their
    // condition badge to be unlocked in the canonical badge-space.
    if (def.unlockCondition && def.unlockCondition !== 'default') {
        var unlockedBadges = charReadUnlockedBadgeIds(nk, logger, ctx.userId);
        if (!unlockedBadges[def.unlockCondition]) {
            logger.info('[Characters] ' + characterId + ' unlock rejected for ' +
                ctx.userId + ' — missing badge: ' + def.unlockCondition);
            return JSON.stringify({
                success: false,
                error: 'condition_not_met',
                characterId: characterId,
                requiredBadge: def.unlockCondition
            });
        }
    }

    var now = new Date().toISOString();
    var xpAwarded = def.xpRewardOnUnlock || 0;

    // Unlock character
    if (!charData.unlockedCharacters) charData.unlockedCharacters = {};
    charData.unlockedCharacters[characterId] = { unlockedAt: now };
    charData.totalXpFromUnlocks = (charData.totalXpFromUnlocks || 0) + xpAwarded;
    charData.updatedAt = now;

    // Rule#7: Award XP ONLY, never currency
    // XP is tracked in metadata, not wallet
    if (xpAwarded > 0) {
        try {
            // Update player metadata with XP
            var account = nk.accountGetId(ctx.userId);
            if (account) {
                var metadata = {};
                try {
                    metadata = JSON.parse(account.user.metadata || '{}');
                } catch (e) { metadata = {}; }

                metadata.totalXp = (metadata.totalXp || 0) + xpAwarded;
                metadata.lastXpSource = 'character_unlock_' + characterId;
                metadata.lastXpAt = now;

                nk.accountUpdateId(ctx.userId, null, null, null, null, null, null, null, JSON.stringify(metadata));
            }
        } catch (xpErr) {
            logger.warn('[Characters] XP update failed for ' + ctx.userId + ': ' + xpErr.message);
            // Non-critical — character is still unlocked
        }
    }

    if (!writeCharacterData(nk, logger, ctx.userId, gameId, charData)) {
        return charErrorResponse('Failed to save character data');
    }

    logger.info('[Characters] ' + characterId + ' unlocked for ' + ctx.userId + ' (+' + xpAwarded + ' XP)');

    return JSON.stringify({
        success: true,
        characterId: characterId,
        name: def.name,
        rarity: def.rarity,
        xpBonus: def.xpBonus,
        xpAwarded: xpAwarded,
        introVideoPath: def.introVideoPath,
        totalUnlocked: Object.keys(charData.unlockedCharacters).length,
        totalCharacters: Object.keys(CHARACTER_DEFS).length,
        timestamp: now
    });
}

// ─── RPC: character_set_active ──────────────────────────────────────────────

function rpcCharacterSetActive(ctx, logger, nk, payload) {
    if (!ctx.userId) return charErrorResponse('User not authenticated');

    var data = charValidatePayload(payload);
    if (data === null) return charErrorResponse('Invalid JSON payload');

    var gameId = data.gameId || data.game_id || 'quizverse';
    var characterId = data.characterId;

    if (!characterId) return charErrorResponse('Missing required field: characterId');

    var def = CHARACTER_DEFS[characterId];
    if (!def) return charErrorResponse('Character not found: ' + characterId);

    var charData = readCharacterData(nk, logger, ctx.userId, gameId);
    if (!charData) {
        charData = initCharacterData(ctx.userId);
    }

    // Must be unlocked
    if (!charData.unlockedCharacters || !charData.unlockedCharacters[characterId]) {
        return charErrorResponse('Character not unlocked: ' + characterId);
    }

    // Already active?
    if (charData.activeCharacter === characterId) {
        return JSON.stringify({
            success: true,
            activeCharacter: characterId,
            alreadyActive: true
        });
    }

    var previousCharacter = charData.activeCharacter;
    charData.activeCharacter = characterId;
    charData.updatedAt = new Date().toISOString();

    if (!writeCharacterData(nk, logger, ctx.userId, gameId, charData)) {
        return charErrorResponse('Failed to save character data');
    }

    // Also update player metadata for quick access
    try {
        var account = nk.accountGetId(ctx.userId);
        if (account) {
            var metadata = {};
            try {
                metadata = JSON.parse(account.user.metadata || '{}');
            } catch (e) { metadata = {}; }
            metadata.activeCharacter = characterId;
            metadata.activeCharacterXpBonus = def.xpBonus;
            nk.accountUpdateId(ctx.userId, null, null, null, null, null, null, null, JSON.stringify(metadata));
        }
    } catch (metaErr) {
        logger.warn('[Characters] Metadata update failed: ' + metaErr.message);
    }

    logger.info('[Characters] ' + ctx.userId + ' switched character: ' + previousCharacter + ' → ' + characterId);

    return JSON.stringify({
        success: true,
        activeCharacter: characterId,
        previousCharacter: previousCharacter,
        xpBonus: def.xpBonus,
        timestamp: new Date().toISOString()
    });
}

// ─── SERVER-SIDE BADGE → CHARACTER CHAIN (BUG FIX 2026-08-06) ───────────────
// Called by badges.js (badgesNotifyCharacterUnlocks) every time one or more
// badges unlock server-side. Unlocks each character whose unlockCondition
// badge is in badgeIds and who isn't unlocked yet.
//
// Previously this chain lived in the Unity client (CharacterUnlockBridge):
// quiz end → client reads badge RPC response → client calls character_unlock.
// Any client failure = character lost forever. Now it is atomic with the
// badge unlock itself — no client involved, works for Flutter/Unity/web.
//
// Rule#7 honored: unlocks award XP ONLY, never currency.
//
// @param {string[]} badgeIds - badge_ids that just unlocked
// @returns {Array} - [{ characterId, name, rarity, xpAwarded, introVideoPath }]
// ─────────────────────────────────────────────────────────────────────────────
function quizverseCharactersAutoUnlock(nk, logger, userId, gameId, badgeIds) {
    var unlockedOut = [];
    if (!userId || !badgeIds || badgeIds.length === 0) return unlockedOut;

    try {
        var badgeSet = {};
        for (var i = 0; i < badgeIds.length; i++) badgeSet[badgeIds[i]] = true;

        var charData = readCharacterData(nk, logger, userId, gameId);
        if (!charData) charData = initCharacterData(userId);
        if (!charData.unlockedCharacters) charData.unlockedCharacters = {};

        var dirty = false;
        var now = new Date().toISOString();

        for (var charId in CHARACTER_DEFS) {
            if (!CHARACTER_DEFS.hasOwnProperty(charId)) continue;
            var def = CHARACTER_DEFS[charId];
            if (!def.unlockCondition || def.unlockCondition === 'default') continue;
            if (!badgeSet[def.unlockCondition]) continue;
            if (charData.unlockedCharacters[charId]) continue;

            // Unlock
            charData.unlockedCharacters[charId] = { unlockedAt: now };
            var xp = def.xpRewardOnUnlock || 0;
            charData.totalXpFromUnlocks = (charData.totalXpFromUnlocks || 0) + xp;
            dirty = true;

            unlockedOut.push({
                characterId: charId,
                name: def.name,
                rarity: def.rarity,
                xpAwarded: xp,
                introVideoPath: def.introVideoPath
            });

            logger.info('[Characters] AUTO-UNLOCK ' + charId + ' for ' + userId +
                ' via badge ' + def.unlockCondition + ' (+' + xp + ' XP)');

            // XP to account metadata (Rule#7: XP only, never currency)
            if (xp > 0) {
                try {
                    var account = nk.accountGetId(userId);
                    if (account) {
                        var metadata = {};
                        try { metadata = JSON.parse(account.user.metadata || '{}'); }
                        catch (e0) { metadata = {}; }
                        metadata.totalXp = (metadata.totalXp || 0) + xp;
                        metadata.lastXpSource = 'character_unlock_' + charId;
                        metadata.lastXpAt = now;
                        nk.accountUpdateId(userId, null, null, null, null, null, null, null, JSON.stringify(metadata));
                    }
                } catch (xpErr) {
                    logger.warn('[Characters] XP update failed for ' + userId + ': ' + xpErr.message);
                }
            }

            // Persistent notification — code 7601 (clear of friend 1–6,
            // badge 100, collectable 101, LAP badge 7501)
            try {
                nk.notificationsSend([{
                    userId: userId,
                    subject: 'Character Unlocked: ' + def.name,
                    content: {
                        type: 'character_unlocked',
                        character_id: charId,
                        name: def.name,
                        rarity: def.rarity,
                        xp_awarded: xp,
                        source_badge: def.unlockCondition
                    },
                    code: 7601,
                    persistent: true
                }]);
            } catch (notifErr) {
                logger.warn('[Characters] Notification failed: ' + notifErr.message);
            }
        }

        if (dirty) {
            charData.updatedAt = now;
            writeCharacterData(nk, logger, userId, gameId, charData);
        }
    } catch (err) {
        logger.error('[Characters] Auto-unlock error: ' + err.message);
    }
    return unlockedOut;
}

// Publish on the global object so badges.js can find the chain defensively
// (load-order independent in the merged goja bundle).
(function(g) {
    g.quizverseCharactersAutoUnlock = quizverseCharactersAutoUnlock;
})(typeof globalThis !== 'undefined' ? globalThis : this);
