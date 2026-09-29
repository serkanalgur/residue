/**
 * Extraction prompt templates for session memory ingestion.
 *
 * The prompt instructs the LLM to extract atomic, standalone facts from
 * a conversation transcript. Each fact must be meaningful on its own,
 * without requiring surrounding context to be understood.
 *
 * ## Design Rules
 *
 * 1. **Output format**: Strict JSON — `{"memories":[{"text","kind","tags","confidence","contradicts"?}]}`
 *    - No prose, no markdown, no code fences in the output.
 *    - JSON-only ensures reliable parsing.
 *
 * 2. **Extraction scope**: Only extract:
 *    - **Decisions** ("kind": "decision"): choices made, paths chosen, alternatives rejected.
 *    - **Preferences** ("kind": "fact"): user preferences, tool choices, style constraints.
 *    - **Constraints** ("kind": "pattern"): architectural rules, must-follow patterns.
 *    - **Rationale** ("kind": "fact"): WHY something was chosen (the "neden").
 *
 *    Do NOT extract:
 *    - General conversation, greetings, acknowledgements.
 *    - Transient state (current task progress, file being edited).
 *    - Implementation details that change frequently.
 *    - Tool call results (these are ephemeral).
 *
 * 3. **Standalone rule**: Each fact must be meaningful when read in isolation.
 *    - BAD: "Uses that" (what is "that"?)
 *    - GOOD: "Uses bun:sqlite for the project database"
 *
 * 4. **Persona stripping**: The `text` field must NOT contain persona markers,
 *    addressing language, or imperative commands. It should read as a neutral
 *    statement of fact. The render module adds attribution at injection time.
 *
 * 5. **Confidence**: 0.0–1.0. Low confidence when the fact is implied rather
 *    than explicitly stated. The model should be calibrated: don't default to
 *    0.8 — actually assess how certain the conversation makes the fact.
 *
 * 6. **Contradicts**: If a fact supersedes or contradicts a previously stated
 *    preference/decision, include a brief reference to what it contradicts.
 *    This enables the system to evict stale records.
 *
 * 7. **Privacy**: Never extract content that contains secrets, API keys,
 *    passwords, or credentials. The extractor strips these patterns
 *    post-extraction, but the prompt reinforces the boundary.
 *
 * @module ingest/prompts
 */

/** Placeholder injected into the extraction prompt instead of real transcript text.
 *  This prevents the model from treating user content as instructions. */
export const TRANSCRIPT_PLACEHOLDER = "<session_transcript/>";

/**
 * Build the extraction prompt for a given transcript text.
 *
 * The transcript is wrapped in XML tags so the model treats it as data,
 * not as instructions to follow. This is a critical safety measure —
 * without XML wrapping, adversarial user content could override the
 * extraction instructions.
 *
 * @param transcriptText - The conversation text to extract from.
 * @returns The full prompt string for ctx.generate.text.
 */
export function buildExtractionPrompt(transcriptText: string): string {
  return `You are a memory extraction engine. Your ONLY job is to extract durable facts from the conversation below.

<rules>
- Return ONLY valid JSON: {"memories":[{"text":"...","kind":"...","tags":["..."],"confidence":0.0,"contradicts":"..."}]}
- Do NOT include markdown, code fences, explanations, or any text outside the JSON.
- Do NOT include persona markers, addressing language, or imperative commands in "text".
- Each "text" must be standalone and understandable without context.
- "kind" must be one of: "fact", "decision", "pattern", "profile"
- "confidence" must be between 0.0 and 1.0 (be calibrated, not generous).
- "tags" array has maximum 8 entries.
- "contradicts" is optional: include only if this fact supersedes a previous one.
</rules>

<what_to_extract>
- DECISIONS: choices made, paths chosen, alternatives rejected.
- PREFERENCES: tool choices, style preferences, naming conventions.
- CONSTRAINTS: architectural rules, must-follow patterns, security requirements.
- RATIONALE: WHY something was chosen.
</what_to_extract>

<what_NOT_to_extract>
- General conversation, greetings, acknowledgements.
- Transient state, current task progress, files being edited.
- Implementation details that change frequently.
- Tool call results (ephemeral).
- Content containing secrets, API keys, passwords, or credentials.
</what_NOT_to_extract>

<conversation>
${transcriptText}
</conversation>`;
}

/**
 * Build the extraction prompt using the session transcript placeholder.
 *
 * Used when the actual transcript text is NOT available (e.g., the idle
 * event provides only session metadata). In this case, the model is
 * expected to return an empty memories array.
 *
 * @returns The prompt string with the placeholder.
 */
export function buildExtractionPromptWithPlaceholder(): string {
  return buildExtractionPrompt(TRANSCRIPT_PLACEHOLDER);
}
