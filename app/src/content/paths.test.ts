/// <reference types="node" />
// GURU-16: learning paths content and the catalogue build. PRD Learning model (class and skill paths),
// TDD 2.6 (learning_path, path_unit) and 2.7 (packs), wireframe decision 16 (class names).
//
// Real shapes and names this file relies on (read, not assumed):
// - content/lessons/*.json are named kg-mr-swar-1.json etc.; their template_id is tpl_kg_mr_swar_1 etc.
//   Paths and packs name lessons by template_id.
// - child_profile.board defaults to 'msb' (app/src/data/profiles.ts); TDD and existing tests use class 'UKG', 'LKG',
//   and the lessons' free-text classes are 'Nursery', 'LKG', 'UKG'.
// - Wireframe class chips: नर्सरी Nursery, ज्युनिअर केजी Junior KG, सीनिअर केजी Senior KG, पहिली Class 1, दुसरी Class 2.
//   Goal tick boxes: मराठी अक्षरं, इंग्लिश अक्षरं, इंग्लिश शब्द आणि अर्थ, अंक 1 ते 20.
//
// Ids pinned here (the contract GURU-20 and GURU-23 read):
//   boards  msb | cbse
//   classes Nursery | LKG | UKG | Class1 | Class2
//   skills  mr_letters | en_letters | en_words | numbers   (a child's goals are skill ids)
//   generated/paths.json  { paths, goals, packs, lessonPack }
//   validatePaths(paths, packs, lessonIds) -> string[]  in app/src/content/validate.ts
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { validatePaths } from './validate';

type Title = { mr: string; en: string };
type PathUnit = { unit_id: string; title: Title; lessons: string[] };
type LearningPath = {
  path_id: string;
  kind: 'class' | 'skill';
  title: Title;
  board?: string;
  class?: string;
  skill?: string;
  pack: string;
  units: PathUnit[];
};
type Packs = Record<string, { title: Title; lessons: string[] }>;
type Goals = Record<string, string[]>;
type Catalogue = { paths: LearningPath[]; goals: Goals; packs: Packs; lessonPack: Record<string, string> };

const APP = path.join(__dirname, '../..');
const ROOT = path.join(APP, '..');
const PATHS_DIR = path.join(ROOT, 'content/paths');
const GENERATED = path.join(APP, 'src/content/generated');

const BOARDS = ['msb', 'cbse'];
const CLASSES: Record<string, Title> = {
  Nursery: { mr: 'नर्सरी', en: 'Nursery' },
  LKG: { mr: 'ज्युनिअर केजी', en: 'Junior KG' },
  UKG: { mr: 'सीनिअर केजी', en: 'Senior KG' },
  Class1: { mr: 'पहिली', en: 'Class 1' },
  Class2: { mr: 'दुसरी', en: 'Class 2' },
};
const SKILLS = ['mr_letters', 'en_letters', 'en_words', 'numbers'];
const STARTER = ['tpl_kg_mr_swar_1', 'tpl_kg_en_letters_1'];

const readJson = (p: string) => JSON.parse(fs.readFileSync(p, 'utf8'));
const sorted = (xs: string[]) => [...xs].sort();

const readPaths = (dir = PATHS_DIR): { file: string; path: LearningPath }[] =>
  fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json') && f !== 'goals.json' && f !== 'packs.json')
    .map((f) => ({ file: f, path: readJson(path.join(dir, f)) as LearningPath }));
const readGoals = (dir = PATHS_DIR): Goals => readJson(path.join(dir, 'goals.json'));
const readPacks = (dir = PATHS_DIR): Packs => readJson(path.join(dir, 'packs.json'));
const contentLessons = (root = ROOT): { template_id: string; learning_language: string }[] =>
  fs
    .readdirSync(path.join(root, 'content/lessons'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJson(path.join(root, 'content/lessons', f)));

const reachable = (paths: LearningPath[]) => [...new Set(paths.flatMap((p) => p.units.flatMap((u) => u.lessons)))];
const packsOf = (packs: Packs, id: string) => Object.keys(packs).filter((k) => packs[k].lessons.includes(id));
const isTitle = (t: unknown) =>
  !!t && typeof (t as Title).mr === 'string' && (t as Title).mr.length > 0 && typeof (t as Title).en === 'string' && (t as Title).en.length > 0;

// ---- content/paths/*.json

test('path files: one class path per board and class, the four skill paths, each in the path shape', () => {
  const files = readPaths();
  const classPaths: LearningPath[] = [];
  const skillPaths: LearningPath[] = [];
  for (const { file, path: p } of files) {
    const where = file;
    expect([where, p.path_id]).toEqual([where, file.replace(/\.json$/, '')]);
    expect([where, isTitle(p.title)]).toEqual([where, true]);
    expect([where, typeof p.pack, p.pack.length > 0]).toEqual([where, 'string', true]);
    expect([where, Array.isArray(p.units) && p.units.length > 0]).toEqual([where, true]);
    const unitIds = p.units.map((u) => u.unit_id);
    expect([where, new Set(unitIds).size]).toEqual([where, unitIds.length]);
    for (const u of p.units) {
      expect([where, u.unit_id, typeof u.unit_id, isTitle(u.title), Array.isArray(u.lessons)]).toEqual([
        where, u.unit_id, 'string', true, true,
      ]);
      for (const l of u.lessons) expect([where, u.unit_id, typeof l]).toEqual([where, u.unit_id, 'string']);
    }
    if (p.kind === 'class') {
      classPaths.push(p);
      expect([where, BOARDS.includes(p.board!), p.class! in CLASSES, p.skill]).toEqual([where, true, true, undefined]);
      // the class name as the parent sees it (decision 16), in both languages
      expect([where, p.title.mr.includes(CLASSES[p.class!].mr), p.title.en.includes(CLASSES[p.class!].en)]).toEqual([
        where, true, true,
      ]);
    } else {
      expect([where, p.kind]).toEqual([where, 'skill']);
      skillPaths.push(p);
      expect([where, SKILLS.includes(p.skill!), p.board, p.class]).toEqual([where, true, undefined, undefined]);
    }
  }

  const pairs = classPaths.map((p) => `${p.board}/${p.class}`);
  expect(sorted(pairs)).toEqual(sorted(BOARDS.flatMap((b) => Object.keys(CLASSES).map((c) => `${b}/${c}`))));
  expect(sorted(skillPaths.map((p) => p.skill!))).toEqual(sorted(SKILLS));
});

test('goals and packs: every class has default skill goals; every reachable lesson sits in exactly one pack; starter holds the first two lessons', () => {
  const paths = readPaths().map((f) => f.path);
  const goals = readGoals();
  const packs = readPacks();
  const lessons = contentLessons();
  const ids = lessons.map((l) => l.template_id);

  expect(sorted(Object.keys(goals))).toEqual(sorted(Object.keys(CLASSES)));
  for (const [cls, skills] of Object.entries(goals)) {
    expect([cls, Array.isArray(skills), new Set(skills).size]).toEqual([cls, true, skills.length]);
    for (const s of skills) expect([cls, s, SKILLS.includes(s)]).toEqual([cls, s, true]);
  }

  for (const [id, pack] of Object.entries(packs)) {
    expect([id, isTitle(pack.title), Array.isArray(pack.lessons)]).toEqual([id, true, true]);
  }
  expect(sorted(packs.starter.lessons)).toEqual(sorted(STARTER));
  for (const p of paths) expect([p.path_id, p.pack in packs]).toEqual([p.path_id, true]);

  // nothing in today's menu is lost: all 8 lessons are reachable, from a class path and from their letters skill path
  const reach = reachable(paths);
  expect(sorted(reach)).toEqual(sorted(ids));
  const classReach = reachable(paths.filter((p) => p.kind === 'class'));
  for (const id of ids) expect([id, classReach.includes(id)]).toEqual([id, true]);
  const skill = (s: string) => sorted(reachable(paths.filter((p) => p.skill === s)));
  const byLang = (lang: string) => sorted(lessons.filter((l) => l.learning_language === lang).map((l) => l.template_id));
  expect(skill('en_letters')).toEqual(byLang('en-IN'));
  expect(skill('mr_letters')).toEqual(byLang('mr-IN'));

  for (const id of reach) expect([id, packsOf(packs, id).length]).toEqual([id, 1]);
});

// ---- validatePaths(paths, packs, lessonIds)

describe('validatePaths', () => {
  // A minimal clean catalogue: every board and class has an empty class path; two lessons in two packs.
  const fixture = () => {
    const paths: LearningPath[] = BOARDS.flatMap((board) =>
      Object.keys(CLASSES).map((cls) => ({
        path_id: `class_${board}_${cls}`,
        kind: 'class' as const,
        title: CLASSES[cls],
        board,
        class: cls,
        pack: 'kg',
        units: [{ unit_id: 'u1', title: { mr: 'एक', en: 'One' }, lessons: [] as string[] }],
      })),
    );
    paths.push({
      path_id: 'skill_mr_letters',
      kind: 'skill',
      title: { mr: 'मराठी अक्षरं', en: 'Marathi letters' },
      skill: 'mr_letters',
      pack: 'kg',
      units: [{ unit_id: 'swar', title: { mr: 'स्वर', en: 'Vowels' }, lessons: ['tpl_a', 'tpl_b'] }],
    });
    const packs: Packs = {
      starter: { title: { mr: 'सुरुवात', en: 'Starter' }, lessons: ['tpl_a'] },
      kg: { title: { mr: 'केजी', en: 'KG' }, lessons: ['tpl_b'] },
    };
    return { paths, packs, lessonIds: ['tpl_a', 'tpl_b'] };
  };
  const run = (f: ReturnType<typeof fixture>) => validatePaths(f.paths, f.packs, f.lessonIds);

  test('the real content validates clean; a path naming an unknown lesson is reported with the path and the lesson', () => {
    const paths = readPaths().map((f) => f.path);
    expect(validatePaths(paths, readPacks(), contentLessons().map((l) => l.template_id))).toEqual([]);

    expect(run(fixture())).toEqual([]);
    const f = fixture();
    f.paths[f.paths.length - 1].units[0].lessons.push('tpl_zqx');
    const errors = run(f);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('skill_mr_letters');
    expect(errors[0]).toContain('tpl_zqx');
  });

  test('a lesson in no pack, a lesson in two packs, and a missing class path for a board and class are each reported', () => {
    const none = fixture();
    none.packs.kg.lessons = [];
    const e1 = run(none);
    expect(e1).toHaveLength(1);
    expect(e1[0]).toContain('tpl_b');

    const two = fixture();
    two.packs.kg.lessons.push('tpl_a');
    const e2 = run(two);
    expect(e2).toHaveLength(1);
    expect(e2[0]).toContain('tpl_a');
    expect(e2[0]).toContain('starter');
    expect(e2[0]).toContain('kg');

    const missing = fixture();
    missing.paths = missing.paths.filter((p) => !(p.board === 'cbse' && p.class === 'Class2'));
    const e3 = run(missing);
    expect(e3).toHaveLength(1);
    expect(e3[0]).toContain('cbse');
    expect(e3[0]).toContain('Class2');
  });
});

// ---- the committed generated catalogue

test('committed generated/paths.json and lessons.json match content/paths', () => {
  const paths = readPaths().map((f) => f.path);
  const packs = readPacks();
  const out = readJson(path.join(GENERATED, 'paths.json')) as Catalogue;

  const byId = (ps: LearningPath[]) => Object.fromEntries(ps.map((p) => [p.path_id, p]));
  expect(byId(out.paths)).toEqual(byId(paths));
  expect(out.goals).toEqual(readGoals());
  expect(out.packs).toEqual(packs);
  const reach = reachable(paths);
  expect(sorted(Object.keys(out.lessonPack))).toEqual(sorted(reach));
  for (const id of reach) expect([id, out.lessonPack[id]]).toEqual([id, packsOf(packs, id)[0]]);
  expect(out.lessonPack.tpl_kg_mr_swar_1).toBe('starter');
  expect(out.lessonPack.tpl_kg_en_letters_1).toBe('starter');

  const lessons = readJson(path.join(GENERATED, 'lessons.json')) as { template_id: string }[];
  expect(sorted(lessons.map((l) => l.template_id))).toEqual(sorted(reach));
});

// ---- npm run build:content

describe('npm run build:content', () => {
  // Runs in a scratch copy of the layout the build reads, so it never rewrites committed generated files
  // or deletes the tracked lesson audio.
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guru16-build-'));
    for (const p of ['content/lessons', 'content/prompts', 'content/paths', 'app/src', 'app/scripts', 'app/package.json']) {
      fs.cpSync(path.join(ROOT, p), path.join(tmp, p), { recursive: true });
    }
    fs.symlinkSync(fs.realpathSync(path.join(APP, 'node_modules')), path.join(tmp, 'app/node_modules'));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const build = () => {
    const r = spawnSync('npm', ['run', 'build:content'], { cwd: path.join(tmp, 'app'), encoding: 'utf8' });
    return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
  };
  const tmpPaths = () => path.join(tmp, 'content/paths');
  const tmpGenerated = (f: string) => path.join(tmp, 'app/src/content/generated', f);

  test('builds lessons.json from the lessons reachable from paths, not a fixed list', () => {
    // drop one lesson from every path and pack: it leaves the menu and the lesson-to-pack map
    const gone = 'tpl_kg_mr_vyanjan_1';
    for (const { file, path: p } of readPaths(tmpPaths())) {
      for (const u of p.units) u.lessons = u.lessons.filter((l) => l !== gone);
      fs.writeFileSync(path.join(tmpPaths(), file), JSON.stringify(p, null, 2));
    }
    const packs = readPacks(tmpPaths());
    for (const k of Object.keys(packs)) packs[k].lessons = packs[k].lessons.filter((l) => l !== gone);
    fs.writeFileSync(path.join(tmpPaths(), 'packs.json'), JSON.stringify(packs, null, 2));

    const { status, out } = build();
    expect([status, status === 0 ? '' : out]).toEqual([0, '']);

    const lessons = readJson(tmpGenerated('lessons.json')) as { template_id: string }[];
    const expected = contentLessons(tmp).map((l) => l.template_id).filter((id) => id !== gone);
    expect(sorted(lessons.map((l) => l.template_id))).toEqual(sorted(expected));
    const catalogue = readJson(tmpGenerated('paths.json')) as Catalogue;
    expect(catalogue.lessonPack[gone]).toBeUndefined();
    expect(sorted(Object.keys(catalogue.lessonPack))).toEqual(sorted(expected));
    expect(catalogue.goals).toEqual(readGoals(tmpPaths()));
  }, 60_000);

  test('exits non-zero, prints the path error and writes nothing when a path names an unknown lesson', () => {
    const before = {
      lessons: fs.readFileSync(tmpGenerated('lessons.json'), 'utf8'),
      paths: fs.existsSync(tmpGenerated('paths.json')) ? fs.readFileSync(tmpGenerated('paths.json'), 'utf8') : null,
    };
    const [{ file, path: p }] = readPaths(tmpPaths()).filter((f) => f.path.kind === 'skill');
    p.units[0].lessons.push('tpl_zqx');
    fs.writeFileSync(path.join(tmpPaths(), file), JSON.stringify(p, null, 2));

    const { status, out } = build();
    expect(status).not.toBe(0);
    expect(out).toContain('tpl_zqx');
    expect(out).toContain(p.path_id);
    expect(fs.readFileSync(tmpGenerated('lessons.json'), 'utf8')).toBe(before.lessons);
    expect(fs.existsSync(tmpGenerated('paths.json')) ? fs.readFileSync(tmpGenerated('paths.json'), 'utf8') : null).toBe(
      before.paths,
    );
  }, 60_000);
});

// ---- contract for dependents (shape only)
// GURU-20 (today's queue, path enrolment): paths with units, default goals per class, lesson-to-pack map.
// GURU-23 (pack build, starter pack bundled): paths, packs and the `starter` pack definition.
test('contract (GURU-20, GURU-23): generated/paths.json shape and validatePaths signature', () => {
  const out = readJson(path.join(GENERATED, 'paths.json')) as Catalogue;
  expect(sorted(Object.keys(out))).toEqual(['goals', 'lessonPack', 'packs', 'paths']);

  expect(Array.isArray(out.paths)).toBe(true);
  for (const p of out.paths) {
    expect(Object.keys(p)).toEqual(expect.arrayContaining(['path_id', 'kind', 'title', 'pack', 'units']));
    expect([typeof p.path_id, typeof p.title.mr, typeof p.title.en, typeof p.pack]).toEqual(['string', 'string', 'string', 'string']);
    expect(['class', 'skill']).toContain(p.kind);
    if (p.kind === 'class') expect([typeof p.board, typeof p.class]).toEqual(['string', 'string']);
    else expect(typeof p.skill).toBe('string');
    for (const u of p.units) {
      expect([typeof u.unit_id, typeof u.title.mr, typeof u.title.en, Array.isArray(u.lessons)]).toEqual([
        'string', 'string', 'string', true,
      ]);
    }
  }
  expect(out.paths.some((p) => p.kind === 'class')).toBe(true);
  expect(out.paths.some((p) => p.kind === 'skill')).toBe(true);

  for (const goals of Object.values(out.goals)) {
    expect(Array.isArray(goals)).toBe(true);
    for (const g of goals) expect(typeof g).toBe('string');
  }

  expect(out.packs.starter).toBeDefined();
  for (const pack of Object.values(out.packs)) {
    expect([typeof pack.title.mr, typeof pack.title.en, Array.isArray(pack.lessons)]).toEqual(['string', 'string', true]);
  }
  for (const pack of Object.values(out.lessonPack)) expect(Object.keys(out.packs)).toContain(pack);

  // validatePaths(paths, packs, lessonIds) -> string[]
  expect(typeof validatePaths).toBe('function');
  const errors = validatePaths([], {}, []);
  expect(Array.isArray(errors)).toBe(true);
  expect(errors.length).toBeGreaterThan(0); // no class paths at all
  for (const e of errors) expect(typeof e).toBe('string');
});
