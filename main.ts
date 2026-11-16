// Driver for markdown-render-speed-02.
//
// The harness runs `node /bot/main.ts` on Node 22. It reads the case
// list from /input/cases.json (an array of {id, markdown}), renders
// every case on its own through parse() from ./parse.js, and writes
// the HTML strings, in order, to /output/html.json.
//
// Outside the grading container the MAKEFUN_INPUT_DIR and
// MAKEFUN_OUTPUT_DIR environment variables stand in for /input and
// /output, which is how the local kit grader points the driver at
// the practice set.

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

type Case = { id: string; markdown: string };

const cases = JSON.parse(
  readFileSync(join(inputDir, 'cases.json'), 'utf8'),
) as Case[];

const rendered: string[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  rendered[i] = parse(cases[i].markdown);
}

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(rendered));
