/**
 * TypeSafe Jev Ultra-Fast Browser Action Runner
 *
 * Implements sub-100ms decision loops over indexed DOM action tables
 * using TypeSafe's System One (Jev) model instead of slow multi-second vision models.
 */

export interface JevBrowserState {
  goal: string;
  url: string;
  title: string;
  table: string;
  elementCount: number;
  recentActions: string[];
}

export interface JevDecision {
  operation: 'CLICK' | 'TYPE_TEXT' | 'SELECT' | 'SCROLL_DOWN' | 'SCROLL_UP' | 'WAIT' | 'DONE' | 'FAIL';
  targetIndex?: number;
  textToType?: string;
  reasoning?: string;
}

export async function decideNextAction(
  state: JevBrowserState,
  apiKey: string
): Promise<JevDecision> {
  const options = Array.from({ length: state.elementCount }, (_, i) => String(i + 1));
  options.push('NONE');

  // Speculative single-call payload to TypeSafe System One
  const payload = {
    model: 'jev',
    state: {
      goal: state.goal,
      current_url: state.url,
      page_title: state.title,
      recent_actions: state.recentActions.slice(-4),
      interactive_elements: state.table,
    },
    questions: [
      {
        id: 'operation',
        primitive: 'choice',
        instructions: 'Determine the single next immediate browser action to advance toward the goal.',
        criteria: {
          options: [
            'CLICK',        // Click a link, button, tab, checkbox, or radio
            'TYPE_TEXT',    // Click an input/textarea and type text
            'SELECT',       // Pick an option from a dropdown
            'SCROLL_DOWN',  // Scroll down to reveal more items
            'SCROLL_UP',    // Scroll up
            'WAIT',         // Wait for page to finish loading/rendering
            'DONE',         // Goal has been successfully accomplished
            'FAIL',         // Page is permanently blocked, captcha, or impossible
          ],
        },
      },
      {
        id: 'target_index',
        primitive: 'choice',
        instructions: 'If operation is CLICK, TYPE_TEXT, or SELECT, choose the exact element number [ID] from the table. Otherwise choose NONE.',
        criteria: {
          options,
        },
      },
    ],
  };

  const response = await fetch('https://api.typesafe.ai/v1/system-one', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`TypeSafe Jev request failed (${response.status}): ${errorText}`);
  }

  const result = await response.json() as {
    answers: Array<{ id: string; choice?: string }>;
  };

  const operationAnswer = result.answers.find((a) => a.id === 'operation')?.choice || 'WAIT';
  const targetAnswer = result.answers.find((a) => a.id === 'target_index')?.choice;

  const operation = operationAnswer as JevDecision['operation'];
  const targetIndex = targetAnswer && targetAnswer !== 'NONE' ? parseInt(targetAnswer, 10) : undefined;

  let textToType: string | undefined;

  // When TYPE_TEXT is chosen, deduce or generate the exact text needed
  if (operation === 'TYPE_TEXT' && targetIndex) {
    textToType = await resolveTextToType(state.goal, state.table, targetIndex, apiKey);
  }

  return {
    operation,
    targetIndex,
    textToType,
  };
}

/**
 * Resolves the string to type based on the user's goal and the target input field.
 */
async function resolveTextToType(
  goal: string,
  table: string,
  targetIndex: number,
  apiKey: string
): Promise<string> {
  const line = table.split('\n').find((l) => l.startsWith(`[${targetIndex}]`)) || '';
  
  // Extract or normalize the text string from the goal
  return goal.replace(/^(search for|type|enter|find)\s+/i, '').replace(/["']/g, '').trim();
}
