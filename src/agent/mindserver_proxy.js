import { io } from 'socket.io-client';
import convoManager from './conversation.js';
import { setSettings } from './settings.js';
import { getFullState } from './library/full_state.js';

// agent's individual connection to the mindserver
// always connect to localhost

function logConn(agentName, event, fields = {}, level = 'info') {
    const encode = (value) => {
        if (value === undefined || value === null) return 'null';
        const text = String(value);
        if (/^[a-zA-Z0-9_.:/-]+$/.test(text)) return text;
        return JSON.stringify(text);
    };
    const details = Object.entries(fields)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${key}=${encode(value)}`)
        .join(' ');
    const line = `[CONN] agent=${encode(agentName || 'unknown')} event=${encode(event)}${details ? ` ${details}` : ''}`;
    if (level === 'warn') console.warn(line);
    else if (level === 'error') console.error(line);
    else console.log(line);
}

class MindServerProxy {
    constructor() {
        if (MindServerProxy.instance) {
            return MindServerProxy.instance;
        }
        
        this.socket = null;
        this.connected = false;
        this.agents = [];
        MindServerProxy.instance = this;
    }

    async connect(name, port) {
        if (this.connected) return;
        
        this.name = name;
        this.socket = io(`http://127.0.0.1:${port}`, {
            reconnection: true,
            reconnectionAttempts: Infinity,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 10000,
            randomizationFactor: 0.4,
            timeout: 10000,
            transports: ['websocket'],
            upgrade: false,
        });

        this.socket.on('connect', () => {
            const wasConnected = this.connected;
            this.connected = true;
            if (wasConnected) {
                console.log(name, 'reconnected to MindServer');
                logConn(name, 'mindserver_reconnect', { port }, 'warn');
            } else {
                console.log(name, 'connected to MindServer');
                logConn(name, 'mindserver_connect', { port }, 'info');
            }

            this.socket.emit('connect-agent-process', name);
            if (this.agent?.bot?.player) {
                this.login();
            }
        });

        await new Promise((resolve, reject) => {
            let lastError = null;
            const timeout = setTimeout(() => {
                this.socket.off('connect', onConnect);
                this.socket.off('connect_error', onConnectError);
                reject(lastError || new Error('MindServer connection timed out'));
            }, 30000);

            const onConnect = () => {
                clearTimeout(timeout);
                this.socket.off('connect', onConnect);
                this.socket.off('connect_error', onConnectError);
                resolve();
            };

            const onConnectError = (err) => {
                lastError = err;
                logConn(name, 'mindserver_connect_error', {
                    reason: err?.message || String(err),
                }, 'warn');
                console.error('Connection attempt failed:', err?.message || err);
            };

            this.socket.on('connect', onConnect);
            this.socket.on('connect_error', onConnectError);
        });

        this.socket.on('disconnect', (reason) => {
            logConn(name, 'mindserver_disconnect', { reason }, 'warn');
            console.log('Disconnected from MindServer:', reason);
            this.connected = false;
            if (reason === 'io server disconnect') {
                this.socket.connect();
            }
        });

        this.socket.on('chat-message', (agentName, json) => {
            convoManager.receiveFromBot(agentName, json);
        });

        this.socket.on('agents-status', (agents) => {
            this.agents = agents;
            convoManager.updateAgents(agents);
            if (this.agent?.task) {
                console.log(this.agent.name, 'updating available agents');
                this.agent.task.updateAvailableAgents(agents);
            }
        });

        this.socket.on('restart-agent', (agentName) => {
            console.log(`Restarting agent: ${agentName}`);
            this.agent.cleanKill();
        });
		
        this.socket.on('send-message', (data) => {
            try {
                this.agent.respondFunc(data.from, data.message);
            } catch (error) {
                console.error('Error: ', JSON.stringify(error, Object.getOwnPropertyNames(error)));
            }
        });

        this.socket.on('get-full-state', (callback) => {
            try {
                const state = getFullState(this.agent);
                callback(state);
            } catch (error) {
                console.error('Error getting full state:', error);
                callback(null);
            }
        });

        // Request settings and wait for response
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Settings request timed out after 5 seconds'));
            }, 5000);

            this.socket.emit('get-settings', name, (response) => {
                clearTimeout(timeout);
                if (response.error) {
                    return reject(new Error(response.error));
                }
                setSettings(response.settings);
                resolve();
            });
        });
    }

    setAgent(agent) {
        this.agent = agent;
    }

    getAgents() {
        return this.agents;
    }

    getNumOtherAgents() {
        return this.agents.length - 1;
    }

    login() {
        this.socket.emit('login-agent', this.agent.name);
    }

    shutdown() {
        this.socket.emit('shutdown');
    }

    getSocket() {
        return this.socket;
    }
}

// Create and export a singleton instance
export const serverProxy = new MindServerProxy();

// for chatting with other bots
export function sendBotChatToServer(agentName, json) {
    serverProxy.getSocket().emit('chat-message', agentName, json);
}

// for sending general output to server for display
export function sendOutputToServer(agentName, message) {
    serverProxy.getSocket().emit('bot-output', agentName, message);
}
