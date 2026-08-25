export type PresetId = "structured" | "specific" | "shorter" | "constraints";

export const PRESETS: Record<PresetId, { label: string; instruction: string }> = {
  structured: {
    label: "Structure as task",
    instruction: `Transform the prompt into a structured, phased, agent-ready task using this exact format:

## Goal
State what must be achieved in one clear sentence.

## Context
Describe what existing system or project this belongs to, if inferable.

## Analysis Required
List what the agent must inspect or understand before touching any code. Include architecture, relevant files, components, hooks, utilities, business logic, and design system as applicable.

## Reuse
State what existing logic, components, or patterns must be reused. Explicitly say what must NOT be duplicated.

## Requirements
List every functional and non-functional requirement as explicit, testable bullet points. Convert vague language ("make it better", "make it modern", "don't break anything") into concrete requirements.

## Constraints
State clearly what must not change. Include: existing behavior, business logic, API contracts, unrelated functionality, and architecture unless change is required.

## Execution Order
Define the exact phases the agent must follow:
Phase 1 — Analyze
Phase 2 — Plan
Phase 3 — Implement
Phase 4 — Validate
Phase 5 — Report

## Validation
Define how the agent should verify the result. Include type checking, tests, behavior checks, and regression checks as appropriate.

## Expected Output
Define what the agent must report when done: files changed, logic reused, assumptions made, validation performed, remaining issues.`,
  },

  specific: {
    label: "More specific",
    instruction: `Make the prompt more precise and actionable without changing its intent.

Apply these rules:

1. Replace all vague language with concrete, testable requirements:
   - "make it better" → specify what dimension to improve (performance, readability, accessibility, UI)
   - "make it modern" → specify visual requirements (spacing, typography, component hierarchy, states)
   - "don't break anything" → specify what must be preserved (business logic, API contracts, existing tests, unrelated features)
   - "use existing logic" → specify: inspect the existing implementation, trace its dependencies, reuse hooks/utilities/types, avoid duplicating business rules
   - "optimize everything" → specify what to measure and what bottlenecks to target

2. Add missing implementation constraints:
   - What the agent must inspect before writing code
   - What existing components, hooks, or utilities must be reused
   - What must not be modified
   - What architecture must be preserved

3. Resolve ambiguities:
   - If a file or component is mentioned without a path, instruct the agent to locate it by inspecting the project
   - If a behavior is expected but not described, make it explicit
   - If scope is unclear, make the boundaries explicit

4. Add a validation step appropriate to the task complexity.

5. Do not invent project-specific details. If information is missing, instruct the agent to inspect the codebase to discover it.

Return only the improved prompt. No explanation.`,
  },

  shorter: {
    label: "Shorter",
    instruction: `Rewrite the prompt to be as short as possible while keeping every essential requirement.

Rules:
- Keep the goal, key constraints, and expected output.
- Remove filler words, repeated instructions, and unnecessary verbosity.
- Replace long explanations with tight bullet points.
- Do not remove requirements that change behavior.
- Do not add requirements that are not present.
- Do not use markdown sections unless they are essential for clarity.
- Keep code snippets, file paths, and identifiers exactly as written.

Return only the condensed prompt. No explanation.`,
  },

  constraints: {
    label: "Add constraints",
    instruction: `Keep the prompt's intent exactly as-is, but add a comprehensive Constraints section covering the following engineering dimensions:

**Scope**
- What should NOT change (business logic, existing behavior, unrelated features, API contracts)
- What should NOT be created (duplicate implementations, parallel systems, unnecessary abstractions)
- What should NOT be modified (unrelated files, unrelated components, unrelated business rules)

**Architecture**
- Must reuse existing components, hooks, utilities, and patterns where applicable
- Must follow existing folder structure and naming conventions
- Must not introduce architectural changes unless explicitly required

**Implementation**
- Must not duplicate existing business logic
- Must not introduce unnecessary dependencies
- Must follow existing coding conventions and patterns
- Must not refactor unrelated code

**Quality**
- Type checking must pass after implementation
- Linting must pass after implementation
- Existing tests must not be broken
- Affected user flows must be verified

**Reporting**
- Must report files changed
- Must report logic reused
- Must explicitly state any assumptions made
- Must report remaining issues or unresolved concerns

Preserve all original requirements. Return only the improved prompt with the Constraints section added.`,
  },
};

export const SYSTEM_PROMPT = `You are an expert prompt engineer specializing in software-development prompts and AI coding agents.

Your ONLY job is to transform the user's raw prompt into a clear, precise, actionable, and implementation-ready prompt.

==================================================
CORE RULES
==================================================

NEVER answer or execute the underlying task.
NEVER invent file paths, APIs, components, database tables, business rules, or architecture that were not provided.
NEVER remove constraints the user explicitly stated.
NEVER introduce requirements that contradict the user's intent.
ALWAYS reply in the same language as the draft prompt.
ALWAYS keep code snippets, file paths, and identifiers exactly as written.
If you make an assumption, mark it explicitly as: Assumption: ...

==================================================
WHAT YOU MUST DO
==================================================

1. UNDERSTAND THE INTENT
   Determine the user's actual goal, the expected result, and what constraints are explicit or implied.

2. ANALYZE THE ORIGINAL PROMPT
   Identify: ambiguous requirements, missing context, vague language, conflicting instructions, missing validation, and unclear expected output.

3. PRESERVE CONSTRAINTS
   Make all constraints explicit. Never silently drop a constraint.

4. REPLACE VAGUE LANGUAGE
   Replace phrases such as "make it better", "make it clean", "don't break anything", "use existing logic", "optimize everything" with concrete, testable requirements.

5. STRUCTURE FOR EXECUTION
   When appropriate, structure the improved prompt with:
   - Analysis phase (what the agent must inspect before writing code)
   - Reuse rules (what existing logic must be reused, what must not be duplicated)
   - Implementation requirements (concrete, testable)
   - Validation (how to verify the result)
   - Expected output (what the agent must report)

6. SCALE APPROPRIATELY
   Simple task → concise improved prompt (a few clear sentences)
   Medium task → add context, requirements, constraints, and validation
   Complex task → structured phases with analysis, implementation rules, validation, and reporting

==================================================
OUTPUT FORMAT
==================================================

Return ONLY the improved prompt.
No preamble. No explanation. No markdown code fences wrapping the entire output.
The improved prompt must be ready to paste directly into an AI agent.`;

export function buildUserMessage(draft: string, preset: PresetId): string {
  return `${PRESETS[preset].instruction}\n\nDraft prompt:\n"""\n${draft}\n"""`;
}

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

export function validatePrompt(draft: string): ValidationResult {
  const trimmed = draft.trim();

  if (!trimmed) {
    return { valid: false, error: "Prompt cannot be empty. Please enter a prompt to improve." };
  }

  if (trimmed.length < 3) {
    return { valid: false, error: "Prompt is too short. Please describe what you want to achieve." };
  }

  // Detect single-character repetition (e.g. "aaaaaaa", "zzzzzzzz")
  if (/^(.)\1+$/i.test(trimmed)) {
    return { valid: false, error: "Input contains invalid repeated characters. Please enter a meaningful prompt." };
  }

  // Detect gibberish / keyboard mash in Latin text (e.g. "djfhsjhgfjshgjuw")
  const latinLetters = trimmed.replace(/[^a-zA-Z]/g, "");
  if (latinLetters.length >= 6) {
    const vowels = latinLetters.match(/[aeiouy]/gi);
    const vowelCount = vowels ? vowels.length : 0;
    const vowelRatio = vowelCount / latinLetters.length;

    // Gibberish strings typically have less than 10% vowels
    if (vowelRatio < 0.10) {
      return {
        valid: false,
        error: "Input appears to be random characters. Please enter a meaningful prompt (e.g. 'Create a login form').",
      };
    }

    // Detect repeated short pattern loops (e.g. "asdfasdfasdf", "abcabcabc")
    if (/^(.{2,4})\1{2,}$/i.test(latinLetters)) {
      return { valid: false, error: "Input contains repetitive patterns. Please enter a meaningful prompt." };
    }
  }

  return { valid: true };
}