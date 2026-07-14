const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { withGeminiRetry } = require('./geminiRetry');

const execFileAsync = promisify(execFile);

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

async function transcribeVoice(audioBuffer) {
  const id = crypto.randomUUID();
  const oggPath = path.join(os.tmpdir(), `${id}.ogg`);
  const mp3Path = path.join(os.tmpdir(), `${id}.mp3`);

  try {
    fs.writeFileSync(oggPath, audioBuffer);
    await execFileAsync('ffmpeg', ['-y', '-i', oggPath, mp3Path]);

    const mp3Base64 = fs.readFileSync(mp3Path).toString('base64');

    const result = await withGeminiRetry(
      () => model.generateContent([
        { text: 'Транскрибируй это голосовое сообщение на русском языке, верни только текст без комментариев.' },
        { inlineData: { mimeType: 'audio/mp3', data: mp3Base64 } },
      ]),
      'gemini-transcribe'
    );

    return result.response.text().trim();
  } finally {
    fs.rm(oggPath, { force: true }, () => {});
    fs.rm(mp3Path, { force: true }, () => {});
  }
}

module.exports = { transcribeVoice };
