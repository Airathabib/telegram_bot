import { Telegraf } from 'telegraf';
import { Mistral } from '@mistralai/mistralai';
import 'dotenv/config';

// === Настройки ===
const TELEGRAM_BOT_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN ||
  '8038560685:AAGOXKqpzr8BfWroxaTX3j-ar_bxZ7-BY90';
const MISTRAL_API_KEY =
  process.env.MISTRAL_API_KEY || 'C7PBgnTAPUdqpIwjUtlQZar8H5zljW1b';
// === Типы из Mistral SDK (объявляем локально, чтобы не было конфликтов) ===
interface TextChunk {
  type: 'text';
  text: string;
}

interface ToolFileChunk {
  type: 'tool_file';
  tool: string;
  fileId: string; // Важно: Mistral использует `fileId`, а не `file_id`
  fileName: string;
  fileType: string;
}

type MessageOutputContent = TextChunk | ToolFileChunk;

interface MessageOutputEntry {
  type: 'message.output';
  content: MessageOutputContent[];
}

// === Инициализация клиентов ===
const mistralClient = new Mistral({ apiKey: MISTRAL_API_KEY });
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

// === Состояние бота для пользователя ===
interface UserState {
  generatingImage: boolean;
}
const userStates = new Map<number, UserState>();

// === Меню команд ===
bot.command('start', (ctx) => {
  ctx.replyWithMarkdown(
    '👋 Привет! Я могу сгенерировать посты с текстом и изображением.\n\n' +
      '🔹 `/text <ваш запрос>` — только текст\n' +
      '🔹 `/image <ваш запрос>` — только изображение\n' +
      '🔹 `Просто напишите что-то` — получите текст + изображение\n' +
      '🔹 `/help` — помощь'
  );
});

bot.command('help', (ctx) => {
  ctx.reply('Напишите любой запрос, и я создам текст и изображение для вас!');
});

// === Генерация изображения через Mistral Medium + image_generation ===
async function generateImage(ctx: any, imagePrompt: string) {
  await ctx.reply('🖼️ Генерирую изображение...');

  try {
    // Создание агента с поддержкой генерации изображений
    const imageAgent = await mistralClient.beta.agents.create({
      model: 'mistral-medium-2505',
      name: 'Image Generation Agent',
      description: 'Agent used to generate images.',
      instructions:
        'Use the image generation tool when you have to create images.',
      tools: [{ type: 'image_generation' }],
      completionArgs: {
        temperature: 0.3,
        topP: 0.95,
      },
    });

    // Запуск диалога
    const conversation = await mistralClient.beta.conversations.start({
      agentId: imageAgent.id,
      inputs: imagePrompt,
    });

    console.log('Raw conversation output:', conversation.outputs); // Для отладки

    // Поиск message.output
    const imageOutput = conversation.outputs.find(
      (output): output is any => output.type === 'message.output'
    );

    if (!imageOutput) {
      await ctx.reply('❌ Не удалось сгенерировать изображение.');
      return;
    }

    // Поиск файла изображения
    const fileEntry = imageOutput.content.find(
      (item: { type: string }): item is any => item.type === 'tool_file'
    );

    if (!fileEntry) {
      await ctx.reply('❌ Файл изображения не найден.');
      return;
    }

    const fileId = fileEntry.fileId;

    // Получение изображения через прямой URL
    const baseUrl = mistralClient['_baseURL']?.toString().replace(/\/$/, '');
    const fileUrl = `${baseUrl}/v1/files/${fileId}/content`;

    const downloadResponse = await fetch(fileUrl, {
      headers: {
        Authorization: `Bearer ${MISTRAL_API_KEY}`,
      },
    });

    if (!downloadResponse.ok) {
      throw new Error('Failed to download file');
    }

    const blob = await downloadResponse.blob();
    const buffer = Buffer.from(await blob.arrayBuffer());

    // Отправка изображения пользователю
    await ctx.replyWithPhoto(
      { source: buffer },
      {
        caption: '🖼️ Ваше сгенерированное изображение',
      }
    );

    await ctx.reply('✅ Ваш пост готов!');
  } catch (error) {
    console.error('Ошибка при генерации изображения:', error);
    await ctx.reply('❌ Не удалось сгенерировать изображение.');
  }
}

// === Обработка простого текста ===
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const prompt = ctx.message.text;

  // Проверяем, не ждём ли мы изображение
  if (userStates.get(userId)?.generatingImage) {
    await generateImage(ctx, prompt);
    userStates.set(userId, { generatingImage: false });
    return;
  }

  await ctx.reply('📝 Генерирую текст...');

  try {
    // Генерация текста
    const textResponse = await mistralClient.chat.complete({
      model: 'mistral-large-latest',
      messages: [{ role: 'user', content: prompt }],
    });

    const generatedText = textResponse.choices[0].message.content;
    await ctx.reply(`✍️ Вот ваш сгенерированный текст:\n\n${generatedText}`);

    // Запрашиваем у пользователя описание изображения
    await ctx.reply(
      '🎨 Теперь опишите, какое изображение вы хотите к этому тексту:'
    );
    userStates.set(userId, { generatingImage: true });
  } catch (error) {
    console.error('Ошибка при генерации текста:', error);
    await ctx.reply('❌ Не удалось сгенерировать текст.');
  }
});

// === Команды /text и /image ===
bot.command('text', async (ctx) => {
  const promptMatch = ctx.match;
  if (!promptMatch || typeof promptMatch !== 'string') {
    return ctx.reply('Введите текст после команды /text');
  }

  const prompt = promptMatch as string;

  await ctx.reply('📝 Генерирую текст...');
  try {
    const response = await mistralClient.chat.complete({
      model: 'mistral-large-latest',
      messages: [{ role: 'user', content: prompt }],
    });

    const content = response.choices[0].message.content;
    await ctx.reply(
      typeof content === 'string' ? content : JSON.stringify(content)
    );
  } catch (error) {
    await ctx.reply('❌ Ошибка при генерации текста.');
  }
});

bot.command('image', async (ctx) => {
  const promptMatch = ctx.match;
  if (!promptMatch || typeof promptMatch !== 'string') {
    return ctx.reply('Введите описание изображения после команды /image');
  }

  const prompt = promptMatch as string;
  await generateImage(ctx, prompt);
});

// === Запуск бота ===
bot.launch();

console.log('✅ Бот запущен...');
