export interface ToolCall {
    id: string;
    type: 'function';
    function: {
        name: string;
        arguments: string;
    };
}

export interface ImageContentPart {
    type: 'image_url';
    image_url: { url: string };
}

export interface TextContentPart {
    type: 'text';
    text: string;
}

export type ContentPart = TextContentPart | ImageContentPart;

export interface Message {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | null | ContentPart[];
    name?: string;
    tool_calls?: ToolCall[];
    tool_call_id?: string;
    checkpoint?: {
        id: string;
        label?: string;
        createdAt?: string;
        messageIndex?: number;
        fileCount?: number;
    };
}

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface Phase {
    id: number;
    name: string;
    description: string;
    status: 'pending' | 'in_progress' | 'completed';
}

export interface Task {
    id: number;
    subject: string;
    description?: string;
    status: TaskStatus;
    blockedBy: number[];
    phaseId?: number | undefined;
}

export interface AgentEvent {
    type: 'system_notification' | 'task_update' | 'process_start' | 'process_end' | 'error';
    message: string;
    data?: any;
}
