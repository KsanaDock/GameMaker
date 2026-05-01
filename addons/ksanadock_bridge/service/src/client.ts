import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';

/**
 * KsanaDock Godot Bridge Client
 * Handles the connection to the Godot Editor plugin.
 */
export class BridgeClient {
    private ws: WebSocket | null = null;
    private url: string;
    private callbacks: Map<string, (result: any) => void> = new Map();
    private methodHandlers: Map<string, (params: any) => Promise<any>> = new Map();

    constructor(port: number = 9090) {
        this.url = `ws://localhost:${port}`;
    }

    public async connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            console.log(`Connecting to Godot at ${this.url}...`);
            this.ws = new WebSocket(this.url);

            this.ws.on('open', () => {
                console.log('Connected to Godot Editor Bridge.');
                resolve();
            });

            this.ws.on('message', (data) => {
                this.handleMessage(data.toString());
            });

            this.ws.on('error', (err) => {
                console.error('WebSocket error:', err);
                reject(err);
            });

            this.ws.on('close', () => {
                console.warn('Disconnected from Godot.');
            });
        });
    }

    private handleMessage(message: string) {
        try {
            const data = JSON.parse(message);
            const id = data.id;

            if (id && this.callbacks.has(id)) {
                // Handling response from Godot
                const callback = this.callbacks.get(id);
                if (callback) {
                    if (data.error) {
                        console.error(`RPC Error (${id}):`, data.error);
                    }
                    callback(data.result);
                    this.callbacks.delete(id);
                }
            } else if (data.method) {
                // Handling request from Godot
                this.handleIncomingRequest(data);
            } else {
                console.log('Received notification/event:', data);
            }
        } catch (e) {
            console.error('Failed to parse message:', message);
        }
    }

    private async handleIncomingRequest(data: any) {
        const { method, params, id } = data;
        const handler = this.methodHandlers.get(method);

        if (handler) {
            try {
                const result = await handler(params);
                if (id) {
                    this.ws?.send(JSON.stringify({ jsonrpc: '2.0', id, result }));
                }
            } catch (error: any) {
                if (id) {
                    this.ws?.send(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: error.message } }));
                }
            }
        } else {
            if (id) {
                this.ws?.send(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } }));
            }
        }
    }

    public onMethod(method: string, handler: (params: any) => Promise<any>) {
        this.methodHandlers.set(method, handler);
    }

    public sendCommand(method: string, params: any = {}): Promise<any> {
        return new Promise((resolve, reject) => {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                return reject(new Error('WebSocket is not connected.'));
            }

            const id = uuidv4();
            const request = {
                jsonrpc: '2.0',
                id,
                method,
                params
            };

            this.callbacks.set(id, resolve);
            this.ws.send(JSON.stringify(request));
            
            // Timeout after 10 seconds
            setTimeout(() => {
                if (this.callbacks.has(id)) {
                    this.callbacks.delete(id);
                    reject(new Error(`Command ${method} timed out.`));
                }
            }, 10000);
        });
    }

    public sendNotification(method: string, params: any = {}): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        this.ws.send(JSON.stringify({
            jsonrpc: '2.0',
            method,
            params
        }));
    }
}
