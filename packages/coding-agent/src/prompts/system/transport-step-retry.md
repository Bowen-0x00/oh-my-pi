<system-injection>
The recent attempts ended with a connection reset or stalled stream before producing a completed answer or tool action. Retrying the same long reasoning unchanged is not making progress.
Keep the user's goal, all constraints, and existing evidence. For your next response, take only the next smallest concrete action. If tools are available, inspect the current working state with one focused tool call or execute one narrowly scoped next step; use its result before planning further. Avoid planning the entire remaining task or generating a large file in this response. Continue the task in small verified steps afterwards; do not claim completion, omit requirements, or ask the user to repeat the task.
</system-injection>
