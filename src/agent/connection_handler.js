import { sendOutputToServer } from './mindserver_proxy.js';

// Definitions of error types, keywords, and full human-readable messages.
const ERROR_DEFINITIONS = {
    'name_conflict': {
        keywords: ['name_taken', 'duplicate_login', 'already connected', 'already logged in', 'username is already'],
        msg: 'Name Conflict: The name is already in use or you are already logged in.',
        isFatal: true
    },
    'access_denied': {
        keywords: ['whitelist', 'not white-listed', 'banned', 'suspended', 'verify'],
        msg: 'Access Denied: You are not whitelisted or banned.',
        isFatal: true
    },
    'server_full': {
        keywords: ['server is full', 'full server'],
        msg: 'Connection Failed: The server is full.',
        isFatal: false
    },
    'version_mismatch': {
        keywords: ['outdated', 'version', 'client'],
        msg: 'Version Mismatch: Client and server versions do not match.',
        isFatal: true
    },
    'maintenance': {
        keywords: ['maintenance', 'updating', 'closed', 'restarting'],
        msg: 'Connection Failed: Server is under maintenance or restarting.',
        isFatal: false
    },
    'network_error': {
        keywords: ['timeout', 'timed out', 'connection lost', 'reset', 'refused', 'keepalive', 'epipe', 'broken pipe'],
        msg: 'Network Error: Connection timed out or was lost.',
        isFatal: false
    },
    'behavior': {
        keywords: ['flying', 'spam', 'speed'],
        msg: 'Kicked: Removed from server due to flying, spamming, or invalid movement.',
        isFatal: true
    }
};

const RETRYABLE_TYPES = new Set(['network_error', 'server_full', 'maintenance']);

function encodeConnValue(value) {
    if (value === undefined || value === null) return 'null';
    const text = String(value);
    if (/^[a-zA-Z0-9_.:/-]+$/.test(text)) {
        return text;
    }
    return JSON.stringify(text);
}

export function logConnectionEvent(agentName, event, fields = {}, level = 'error') {
    const entries = Object.entries(fields)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${key}=${encodeConnValue(value)}`);
    const parts = ['[CONN]', `agent=${encodeConnValue(agentName || 'system')}`, `event=${encodeConnValue(event)}`, ...entries];
    const line = parts.join(' ');
    if (level === 'warn') {
        console.warn(line);
    } else if (level === 'info') {
        console.log(line);
    } else {
        console.error(line);
    }
    try { sendOutputToServer(agentName || 'system', line); } catch (_) {}
}

// Helper to log messages to console (once) and MindServer.
export const log = (agentName, msg) => {
    // Use console.error for visibility in terminal
    console.error(msg);
    try { sendOutputToServer(agentName || 'system', msg); } catch (_) {}
};

// Analyzes the kick reason and returns a full, human-readable sentence.
export function parseKickReason(reason) {
    if (!reason) return { type: 'unknown', msg: 'Unknown reason (Empty)', isFatal: true };
    
    const raw = (typeof reason === 'string' ? reason : JSON.stringify(reason)).toLowerCase();

    // Search for keywords in definitions
    for (const [type, def] of Object.entries(ERROR_DEFINITIONS)) {
        if (def.keywords.some(k => raw.includes(k))) {
            console.error(`Disconnected: ${raw}`);
            return { type, msg: def.msg, isFatal: def.isFatal };
        }
    }
    
    // Fallback: Extract text from JSON
    let fallback = raw;
    try {
        const obj = typeof reason === 'string' ? JSON.parse(reason) : reason;
        fallback = obj.translate || obj.text || (obj.value?.translate) || raw;
    } catch (_) {}
    
    return { type: 'other', msg: `Disconnected: ${fallback}`, isFatal: true };
}

export function getDisconnectionPolicy(reason, options = {}) {
    const source = options.source || 'minecraft';
    if (source === 'mindserver') {
        return {
            type: 'mindserver_disconnect',
            msg: 'MindServer connection was lost.',
            isFatal: false,
            retryable: true
        };
    }

    const parsed = parseKickReason(reason);
    return {
        type: parsed.type,
        msg: parsed.msg,
        isFatal: parsed.isFatal,
        retryable: RETRYABLE_TYPES.has(parsed.type) || !parsed.isFatal
    };
}

// Centralized handler for disconnections.
export function handleDisconnection(agentName, reason, options = {}) {
    const { type, msg, isFatal, retryable } = getDisconnectionPolicy(reason, options);
    const source = options.source || 'minecraft';
    const trigger = options.trigger || 'unknown';
    
    // Format: [LoginGuard] Error Message
    const finalMsg = `[LoginGuard] ${msg}`;

    logConnectionEvent(agentName, 'disconnect', {
        source,
        trigger,
        type,
        fatal: isFatal,
        retryable,
        reason: typeof reason === 'string' ? reason : JSON.stringify(reason),
    }, 'error');
    
    // Only call log once (it handles console printing)
    log(agentName, finalMsg);
    
    return { type, msg: finalMsg, isFatal, retryable };
}

// Validates name format.
export function validateNameFormat(name) {
    if (!name || !/^[a-zA-Z0-9_]{3,16}$/.test(name)) {
        return { 
            success: false, 
            // Added [LoginGuard] prefix here for consistency
            msg: `[LoginGuard] Invalid name '${name}'. Must be 3-16 alphanumeric/underscore characters.` 
        };
    }
    return { success: true };
}