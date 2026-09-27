import { MCP001 } from './MCP001.js';
import { MCP002 } from './MCP002.js';
import { MCP003 } from './MCP003.js';
import { MCP004 } from './MCP004.js';
import { MCP005 } from './MCP005.js';
import { MCP006 } from './MCP006.js';
import { MCP007 } from './MCP007.js';
import { MCP008 } from './MCP008.js';
import { MCP009 } from './MCP009.js';
import { MCP010 } from './MCP010.js';
import { MCP011 } from './MCP011.js';
import { MCP012 } from './MCP012.js';
import { MCP013 } from './MCP013.js';
import { MCP014 } from './MCP014.js';
import { MCP015 } from './MCP015.js';
import { MCP016 } from './MCP016.js';
import { MCP017 } from './MCP017.js';
import { MCP018 } from './MCP018.js';
import { MCP019 } from './MCP019.js';
import type { Rule, TransportKind } from './types.js';

/**
 * The rule registry.
 *
 * Adding a rule means adding its file, importing it here, and adding a test.
 * Ids are permanent: a retired rule is removed from this array but its number
 * is never reissued, so a suppression in someone's CI config cannot silently
 * start suppressing something else.
 */
export const ALL_RULES: readonly Rule[] = [
  MCP001,
  MCP002,
  MCP003,
  MCP004,
  MCP005,
  MCP006,
  MCP007,
  MCP008,
  MCP009,
  MCP010,
  MCP011,
  MCP012,
  MCP013,
  MCP014,
  MCP015,
  MCP016,
  MCP017,
  MCP018,
  MCP019,
];

export function rulesFor(kind: TransportKind): Rule[] {
  return ALL_RULES.filter((rule) => rule.appliesTo.includes(kind));
}

export function ruleById(id: string): Rule | undefined {
  return ALL_RULES.find((rule) => rule.id.toLowerCase() === id.toLowerCase());
}

export * from './types.js';
