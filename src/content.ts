// Loads and validates public/content.json. Everything the game shows comes
// from that file, so a bad edit should fail loudly with a readable message.

export interface QuizQuestion {
  prompt: string;
  options: string[];
  correct: number;
}

export interface Content {
  title: string;
  passage: string;
  quiz: {
    secondsPerQuestion: number;
    questions: QuizQuestion[];
  };
  grumble: {
    intro: string;
    scale: string[];
    scenarios: string[];
  };
}

export const OPTION_COUNT = 4;
export const SCALE_POINTS = 5;

function fail(msg: string): never {
  throw new Error(`content.json: ${msg}`);
}

function str(v: unknown, where: string): string {
  if (typeof v !== 'string' || v.trim() === '') fail(`${where} must be non-empty text`);
  return v;
}

function strList(v: unknown, where: string): string[] {
  if (!Array.isArray(v)) fail(`${where} must be a list`);
  return v.map((item, i) => str(item, `${where}[${i}]`));
}

function obj(v: unknown, where: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(`${where} must be an object`);
  return v as Record<string, unknown>;
}

export function validateContent(raw: unknown): Content {
  const root = obj(raw, 'the file');
  const quiz = obj(root.quiz, 'quiz');
  const grumble = obj(root.grumble, 'grumble');

  const seconds = quiz.secondsPerQuestion ?? 0;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
    fail('quiz.secondsPerQuestion must be a number, or 0 for no countdown');
  }

  if (!Array.isArray(quiz.questions)) fail('quiz.questions must be a list');
  const questions = quiz.questions.map((q, i) => {
    const where = `quiz.questions[${i}]`;
    const question = obj(q, where);
    const options = strList(question.options, `${where}.options`);
    if (options.length !== OPTION_COUNT) fail(`${where} needs exactly ${OPTION_COUNT} options`);
    const correct = question.correct;
    if (typeof correct !== 'number' || !Number.isInteger(correct) || correct < 0 || correct >= OPTION_COUNT) {
      fail(`${where}.correct must be a whole number from 0 to ${OPTION_COUNT - 1}`);
    }
    return { prompt: str(question.prompt, `${where}.prompt`), options, correct };
  });

  const scale = strList(grumble.scale, 'grumble.scale');
  if (scale.length !== SCALE_POINTS) fail(`grumble.scale needs exactly ${SCALE_POINTS} labels`);

  return {
    title: str(root.title, 'title'),
    passage: str(root.passage, 'passage'),
    quiz: { secondsPerQuestion: seconds, questions },
    grumble: {
      intro: str(grumble.intro, 'grumble.intro'),
      scale,
      scenarios: strList(grumble.scenarios, 'grumble.scenarios'),
    },
  };
}

export async function loadContent(): Promise<Content> {
  const res = await fetch(`${import.meta.env.BASE_URL}content.json`, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Could not load content.json (${res.status})`);
  return validateContent(await res.json());
}
