import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { logoutAgent } from '../mindcraft/mindserver.js';

const init_agent_path = fileURLToPath(new URL('./init_agent.js', import.meta.url));

function connLog(name, event, fields = {}, level = 'info') {
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
    const line = `[CONN] agent=${encode(name)} event=${encode(event)}${details ? ` ${details}` : ''}`;
    if (level === 'warn') console.warn(line);
    else if (level === 'error') console.error(line);
    else console.log(line);
}

export class AgentProcess {
    constructor(name, port) {
        this.name = name;
        this.port = port;
        this.restartAttempts = 0;
        this.restartTimer = null;
        this.retryConfig = {
            maxAttempts: 6,
            resetAfterMs: 2 * 60 * 1000,
            baseDelayMs: 1500,
            maxDelayMs: 15000,
            jitterMs: 1200
        };
    }

    start(load_memory=false, init_message=null, count_id=0) {
        this.count_id = count_id;
        this.running = true;
        connLog(this.name, 'process_start', { load_memory, count_id }, 'info');

        let args = [init_agent_path, this.name];
        args.push('-n', this.name);
        args.push('-c', count_id);
        if (load_memory)
            args.push('-l', load_memory);
        if (init_message)
            args.push('-m', init_message);
        args.push('-p', this.port);

        const agentProcess = spawn(process.execPath, args, {
            stdio: 'inherit',
            stderr: 'inherit',
        });
        
        const startTime = Date.now();
        agentProcess.on('exit', (code, signal) => {
            console.log(`Agent process exited with code ${code} and signal ${signal}`);
            connLog(this.name, 'process_exit', { code, signal }, code === 0 ? 'info' : 'warn');
            this.running = false;
            logoutAgent(this.name);

            if (code > 1) {
                console.log(`Ending task`);
                process.exit(code);
                return;
            }

            if (code !== 0 && signal !== 'SIGINT') {
                const uptimeMs = Date.now() - startTime;
                if (uptimeMs >= this.retryConfig.resetAfterMs) {
                    this.restartAttempts = 0;
                }

                this.restartAttempts += 1;
                if (this.restartAttempts > this.retryConfig.maxAttempts) {
                    connLog(this.name, 'restart_exhausted', {
                        attempts: this.restartAttempts - 1,
                        max_attempts: this.retryConfig.maxAttempts,
                    }, 'error');
                    console.error(`Agent ${this.name} exceeded reconnect attempts (${this.retryConfig.maxAttempts}) and will not be restarted.`);
                    return;
                }

                const backoffMs = Math.min(
                    this.retryConfig.maxDelayMs,
                    this.retryConfig.baseDelayMs * (2 ** (this.restartAttempts - 1))
                );
                const jitterMs = Math.floor(Math.random() * this.retryConfig.jitterMs);
                const delayMs = backoffMs + jitterMs;
                connLog(this.name, 'restart_scheduled', {
                    attempt: this.restartAttempts,
                    max_attempts: this.retryConfig.maxAttempts,
                    delay_ms: delayMs,
                }, 'warn');

                console.log(`Restarting agent ${this.name} in ${delayMs}ms (attempt ${this.restartAttempts}/${this.retryConfig.maxAttempts})...`);
                this.restartTimer = setTimeout(() => {
                    this.restartTimer = null;
                    this.start(true, 'Agent process restarted.', this.count_id);
                }, delayMs);
            } else {
                this.restartAttempts = 0;
            }
        });
    
        agentProcess.on('error', (err) => {
            connLog(this.name, 'process_error', { reason: String(err) }, 'error');
            console.error('Agent process error:', err);
        });

        this.process = agentProcess;
    }

    stop() {
        if (!this.running) return;
        connLog(this.name, 'process_stop', {}, 'info');
        if (this.restartTimer) {
            clearTimeout(this.restartTimer);
            this.restartTimer = null;
        }
        this.process.kill('SIGINT');
    }

    forceRestart() {
        if (this.running && this.process && !this.process.killed) {
            console.log(`Agent process for ${this.name} is still running. Attempting to force restart.`);
            
            const restartTimeout = setTimeout(() => {
                console.warn(`Agent ${this.name} did not stop in time. It might be stuck.`);
            }, 5000); // 5 seconds to exit

            this.process.once('exit', () => {
                 clearTimeout(restartTimeout);
                 console.log(`Stopped hanging agent ${this.name}. Now restarting.`);
                 this.start(true, 'Agent process restarted.', this.count_id);
            });
            this.stop(); // sends SIGINT
        } else {
             this.start(true, 'Agent process restarted.', this.count_id);
        }
    }
}