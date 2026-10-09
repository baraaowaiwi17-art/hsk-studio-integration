
import { getStore } from '@netlify/blobs';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store'
};

const reply = (statusCode, body) => ({
  statusCode,
  headers,
  body: JSON.stringify(body)
});

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers,
      body: ''
    };
  }

  if (!['GET', 'POST'].includes(event.httpMethod)) {
    return reply(405, { error: 'Method not allowed' });
  }
  
  if (event.httpMethod === 'POST') {
    const expected = process.env.HSK_API_KEY;
    const auth =
      event.headers?.authorization ||
      event.headers?.Authorization ||
      '';

    if (!expected) {
      return reply(503, {
        error: 'Server is not configured. Set HSK_API_KEY in Netlify.'
      });
    }

    if (auth !== `Bearer ${expected}`) {
      return reply(401, { error: 'Unauthorized' });
    }
  }


  if (auth !== `Bearer ${expected}`) {
    return reply(401, { error: 'Unauthorized' });
  }

  try {
    const store = getStore('hsk-studio-vocabulary');
    const current = (await store.get('words', {
      type: 'json'
    })) || [];

    if (event.httpMethod === 'GET') {
      return reply(200, { words: current });
    }

    let payload;

    try {
      payload = JSON.parse(event.body || '{}');
    } catch {
      return reply(400, { error: 'Invalid JSON body.' });
    }

    if (
      !payload ||
      !Array.isArray(payload.words) ||
      payload.words.length < 1 ||
      payload.words.length > 100
    ) {
      return reply(400, {
        error: 'Send a words array containing 1–100 entries.'
      });
    }

    const clean = payload.words.map((word) => {
      if (
        !word ||
        typeof word.hanzi !== 'string' ||
        !word.hanzi.trim()
      ) {
        throw new Error(
          'Every word needs a non-empty hanzi field.'
        );
      }

      const lesson = Number(word.lesson || 1);

      if (
        !Number.isInteger(lesson) ||
        lesson < 1 ||
        lesson > 10
      ) {
        throw new Error(
          'Lesson must be a number from 1 to 10.'
        );
      }

      const result = {
        hanzi: word.hanzi.trim(),
        lesson
      };

      for (const key of [
        'pinyin',
        'arabic',
        'english',
        'pos',
        'example',
        'examplePinyin',
        'exampleMeaning',
        'notes'
      ]) {
        result[key] =
          typeof word[key] === 'string'
            ? word[key].trim().slice(0, 2000)
            : '';
      }

      return result;
    });

    let added = 0;
    let updated = 0;

    for (const word of clean) {
      const index = current.findIndex(
        (saved) =>
          saved.hanzi === word.hanzi &&
          Number(saved.lesson) === word.lesson
      );

      if (index >= 0) {
        current[index] = {
          ...current[index],
          ...word
        };
        updated++;
      } else {
        current.push(word);
        added++;
      }
    }

    await store.setJSON('words', current);

    return reply(200, {
      ok: true,
      added,
      updated,
      total: current.length,
      message:
        'Vocabulary saved. Open HSK Studio and sync words.'
    });
  } catch (error) {
    return reply(400, {
      error: error?.message || 'Request failed.'
    });
  }
};
