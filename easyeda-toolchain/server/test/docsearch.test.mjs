import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchIndex } from '../src/docsearch.mjs';

const fixture = {
  classes: [
    {
      name: 'DMT_Project',
      module: 'dmt',
      summary: '文档树 / 工程管理类',
      methods: [
        'getCurrentProjectInfo(): Promise<IDMT_ProjectItem | undefined>;',
        'getAllProjectsUuid(teamUuid?: string): Promise<Array<string>>;',
        'openProject(projectUuid: string): Promise<boolean>;',
      ],
    },
    {
      name: 'PCB_Drc',
      module: 'pcb',
      summary: 'PCB 设计规则检查类',
      methods: ['check(strict: boolean, userInterface: boolean, includeVerboseError?: boolean): Promise<boolean | Array<any>>;'],
    },
  ],
  enums: [
    { name: 'EDMT_EditorDocumentType', summary: '编辑器文档类型', values: [['PCB', '3'], ['SCHEMATIC_PAGE', '1']] },
  ],
  interfaces: [],
  types: [],
};

test('按方法名命中类', () => {
  const { results } = searchIndex(fixture, 'getAllProjectsUuid');
  assert.equal(results.length, 1);
  assert.equal(results[0].name, 'DMT_Project');
  assert.ok(results[0].snippet.includes('getAllProjectsUuid'));
});

test('按类名命中 + 枚举值命中', () => {
  const byClass = searchIndex(fixture, 'PCB_Drc');
  assert.equal(byClass.results[0].name, 'PCB_Drc');
  const byEnum = searchIndex(fixture, 'PCB');
  assert.ok(byEnum.results.some((r) => r.name === 'EDMT_EditorDocumentType'));
});

test('空查询返回空结果', () => {
  const { results, total } = searchIndex(fixture, '   ');
  assert.equal(results.length, 0);
  assert.equal(total, 0);
});

test('maxResults 截断 + truncated 标记', () => {
  const { results, truncated, total } = searchIndex(fixture, 'PCB', 1);
  assert.equal(results.length, 1);
  assert.equal(truncated, true);
  assert.ok(total > 1);
});

test('无命中返回空', () => {
  const { results } = searchIndex(fixture, 'zzz_nothing');
  assert.equal(results.length, 0);
});
