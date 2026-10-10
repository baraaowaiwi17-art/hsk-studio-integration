import { getStore, connectLambda } from '@netlify/blobs';
import { timingSafeEqual } from 'node:crypto';

const headers = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store'
};

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const TEXT_FIELDS = [
  'pinyin',
  'arabic',
  'english',
  'pos',
  'example',
  'examplePinyin',
  'exampleMeaning',
  'notes'
];

const wordSchema = {
  type: 'object',
  properties: {
    hanzi: {
      type: 'string',
      description: 'Chinese word exactly as shown in the verified source'
    },
    lesson: { type: 'integer', minimum: 1, maximum: 10 },
    pinyin: { type: 'string' },
    arabic: { type: 'string' },
    english: { type: 'string' },
    pos: { type: 'string' },
    example: { type: 'string' },
    examplePinyin: { type: 'string' },
    exampleMeaning: { type: 'string' },
    notes: { type: 'string' }
  },
  required: ['hanzi', 'lesson']
};

const tools = [
  {
    name: 'get_hsk_words',
    description:
      'Get the vocabulary already saved in HSK Studio. Use this before adding words to avoid duplicates. Optionally filter by lesson (1-10).',
    inputSchema: {
      type: 'object',
      properties: {
        lesson: { type: 'integer', minimum: 1, maximum: 10 }
      }
    },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'add_hsk_words',
    description:
      'Save 1 to 100 words to HSK Studio. Only send words verified from the textbook or explicitly provided by the user. Lesson must be 1-10. A word with the same hanzi in the same lesson is updated, not duplicated.',
    inputSchema: {
      type: 'object',
      properties: {
        words: {
          type: 'array',
          minItems: 1,
          maxItems: 100,
          items: wordSchema
        }
      },
      required: ['words']
    }
  },
  {
    name: 'delete_hsk_words',
    description:
      'Permanently delete specific words from HSK Studio, matched by exact hanzi and lesson. Use ONLY when the user explicitly asks to delete these exact words. First list the candidate words with get_hsk_words, show them to the user, and wait for the user to confirm. Then call this tool with confirm set to true.',
    inputSchema: {
      type: 'object',
      properties: {
        words: {
          type: 'array',
          minItems: 1,
          maxItems: 100,
          items: {
            type: 'object',
            properties: {
              hanzi: { type: 'string' },
              lesson: { type: 'integer', minimum: 1, maximum: 10 }
            },
            required: ['hanzi', 'lesson']
          }
        },
        confirm: { type: 'boolean' }
      },
      required: ['words', 'confirm']
    },
    annotations: { destructiveHint: true }
  }
];

function json(statusCode, body) {
  return { statusCode, headers, body: JSON.stringify(body) };
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function toolText(text, isError = false) {
  return { content: [{ type: 'text', text }], isError };
}

function cleanWords(words) {
  if (!Array.isArray(words) || words.length < 1 || words.length > 100) {
    throw new Error('Send a words array containing 1-100 entries.');
  }
  return words.map((word) => {
    if (!word || typeof word.hanzi !== 'string' || !word.hanzi.trim()) {
      throw new Error('Every word needs a non-empty hanzi field.');
    }
    const lesson = Number(word.lesson || 1);
    if (!Number.isInteger(lesson) || lesson < 1 || lesson > 10) {
      throw new Error('Lesson must be a number from 1 to 10.');
    }
    const result = { hanzi: word.hanzi.trim(), lesson };
    for (const key of TEXT_FIELDS) {
      result[key] =
        typeof word[key] === 'string' ? word[key].trim().slice(0, 2000) : '';
    }
    return result;
  });
}

async function callTool(store, name, args) {
  try {
    const current = (await store.get('words', { type: 'json' })) || [];

    if (name === 'get_hsk_words') {
      let words = current;
      if (args && args.lesson !== undefined) {
        words = current.filter(
          (w) => Number(w.lesson) === Number(args.lesson)
        );
      }
      return toolText(JSON.stringify({ total: words.length, words }));
    }

    if (name === 'add_hsk_words') {
      const clean = cleanWords(args && args.words);
      let added = 0;
      let updated = 0;
      for (const word of clean) {
        const index = current.findIndex(
          (saved) =>
            saved.hanzi === word.hanzi &&
            Number(saved.lesson) === word.lesson
        );
        if (index >= 0) {
          current[index] = { ...current[index], ...word };
          updated++;
        } else {
          current.push(word);
          added++;
        }
      }
      await store.setJSON('words', current);
      return toolText(
        JSON.stringify({
          ok: true,
          added,
          updated,
          total: current.length,
          message: 'Vocabulary saved. Open HSK Studio and sync words.'
        })
      );
    }

    if (name === 'delete_hsk_words') {
      if (!args || args.confirm !== true) {
        return toolText(
          'Nothing was deleted. confirm must be true, and only after the user explicitly approved deleting these exact words.',
          true
        );
      }
      const targets = args.words;
      if (!Array.isArray(targets) || targets.length < 1 || targets.length > 100) {
        throw new Error('Send a words array containing 1-100 entries.');
      }
      const keys = targets.map((t) => {
        if (!t || typeof t.hanzi !== 'string' || !t.hanzi.trim()) {
          throw new Error('Every item needs a non-empty hanzi field.');
        }
        const lesson = Number(t.lesson);
        if (!Number.isInteger(lesson) || lesson < 1 || lesson > 10) {
          throw new Error('Lesson must be a number from 1 to 10.');
        }
        return { hanzi: t.hanzi.trim(), lesson };
      });
      const matches = (saved, k) =>
        saved.hanzi === k.hanzi && Number(saved.lesson) === k.lesson;
      const remaining = current.filter(
        (saved) => !keys.some((k) => matches(saved, k))
      );
      const removed = current.length - remaining.length;
      const notFound = keys
        .filter((k) => !current.some((saved) => matches(saved, k)))
        .map((k) => k.hanzi + ' (lesson ' + k.lesson + ')');
      if (removed > 0) {
        await store.setJSON('words', remaining);
      }
      return toolText(
        JSON.stringify({
          ok: true,
          removed,
          notFound,
          total: remaining.length
        })
      );
    }

    return toolText('Unknown tool: ' + name, true);
  } catch (error) {
    console.error('HSK MCP tool error:', error);
    return toolText(error?.message || 'Unknown error.', true);
  }
}

async function handleRpc(store, msg) {
  if (!msg || typeof msg !== 'object') {
    return rpcError(null, -32600, 'Invalid request');
  }
  if (typeof msg.method !== 'string') {
    return null;
  }
  const isNotification = msg.id === undefined;
  const id = msg.id ?? null;
  if (isNotification) return null;

  switch (msg.method) {
    case 'initialize': {
      const requested = msg.params?.protocolVersion;
      const version = PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : PROTOCOL_VERSIONS[0];
      return rpcResult(id, {
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: { name: 'hsk-studio', version: '1.1.0' },
        instructions:
          'Saves and reads HSK 3.0 vocabulary for HSK Studio. Check existing words before adding. Only add words verified from the textbook or given by the user. Never delete words unless the user explicitly approved the exact list.'
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools });
    case 'tools/call': {
      const name = msg.params?.name;
      if (!tools.some((t) => t.name === name)) {
        return rpcError(id, -32602, 'Unknown tool: ' + name);
      }
      const result = await callTool(
        store,
        name,
        msg.params?.arguments || {}
      );
      return rpcResult(id, result);
    }
    default:
      return rpcError(id, -32601, 'Method not found: ' + msg.method);
  }
}

export const handler = async (event) => {
  connectLambda(event);

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  const secret = process.env.HSK_MCP_SECRET;
  if (!secret || secret.length < 20) {
    return json(503, {
      error: 'HSK_MCP_SECRET is missing or too short in Netlify.'
    });
  }

  const provided = event.queryStringParameters?.key || '';
  if (!safeEqual(provided, secret)) {
    return json(401, { error: 'Unauthorized' });
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { ...headers, Allow: 'POST' },
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  let payload;
  try {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body || '', 'base64').toString('utf8')
      : event.body || '';
    payload = JSON.parse(raw);
  } catch {
    return json(400, rpcError(null, -32700, 'Parse error'));
  }

  try {
    const store = getStore('hsk-studio-vocabulary');

    if (Array.isArray(payload)) {
      const replies = [];
      for (const msg of payload) {
        const reply = await handleRpc(store, msg);
        if (reply) replies.push(reply);
      }
      if (replies.length === 0) {
        return { statusCode: 202, headers, body: '' };
      }
      return json(200, replies);
    }

    const reply = await handleRpc(store, payload);
    if (!reply) {
      return { statusCode: 202, headers, body: '' };
    }
    return json(200, reply);
  } catch (error) {
    console.error('HSK MCP error:', error);
    return json(500, rpcError(null, -32603, 'Internal error'));
  }
};
