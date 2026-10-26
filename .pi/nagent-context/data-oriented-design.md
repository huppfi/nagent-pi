# Data-oriented design (Mike Acton): operating rules

Every program transforms data from one form into another. Solve for the data you
actually have, on the hardware you actually run on, and do no work the output
doesn't need.

## Before writing code

- Name the input and the output concretely: shape, size, value ranges, common
  values. If real input exists, read it. For a fact you need but can't observe,
  write `ASSUMPTION: <fact>` and pick a design that is cheap to change if it is
  wrong.
- Use every stated constraint (bounds, ranges, invariants) to remove work.
  Don't invent constraints, options or output changes the request didn't ask
  for.

## Design

- First ask what work can be skipped entirely: a step that can't affect the
  output, or a result you can compute directly instead of simulating it. Then
  ask what can be done once instead of repeatedly, or fewer times. Not doing
  the work beats doing it fast.
- Where there is one, there are many: write transforms over arrays, not over
  one object at a time.
- Lay data out by how the hot loop reads it: contiguous arrays, indices
  instead of pointers, hot fields apart from cold ones. Order loops so each
  item's state stays in locals and memory is read front to back.
- Keep the common case straight-line, with rare and error cases outside it.
  Out-of-range input gets an explicit behavior (reject, clamp or error), never
  an undefined one.
- Add no abstraction, parameter or extension point without a current need.

## Memory: no runtime allocation (hard rule)

Applies to code you write or edit in languages where you control allocation (C, C++,
Rust, Zig, Odin and similar). Ignore it in garbage-collected languages and
shell.

- Never allocate memory at runtime. That means no malloc/calloc/realloc/free,
  new/delete, growing containers (vector push_back, Vec::push, String
  appends) and no library calls that exist to allocate for you (strdup,
  asprintf, getline with a NULL buffer).
- Use static storage: global or static arrays sized at compile time from known
  bounds, meaning the limits the spec states or the problem's own constants.
  Small fixed-size locals on the stack are fine. Library internals, such as
  stdio's buffers, are not your allocations.
- Only when static storage is impossible, because the input decides a size and
  nothing states a bound, you may allocate once at startup. Size each block
  exactly from the input (a counting pass, the file size, a header count)
  before processing begins. Never allocate inside the processing loop, never
  grow a block, never free piece by piece. Mapping the input file counts as
  this exception. Put a one-line comment at the allocation saying why static
  storage is impossible.
- Never invent a capacity limit the spec doesn't give just to make storage
  static.

## Editing existing code

- Every edit follows every rule, small or large, the memory rule included.
  Editing is not an exception.
- When the code your change touches breaks a rule, for example by allocating
  at runtime, fix that code as part of the change. "Touches" means the
  functions and data your change reads or writes. Leave code the change does
  not touch alone unless asked.
- In your reply, list what you changed beyond the request and why, so it can be
  reviewed.

## Claims

- Make no performance claim you haven't measured. Measure before and after, or
  label the claim a hypothesis and name the measurement that would settle it.

## Scale

- Small changes (a bug fix, a flag, a refactor) need no plan, but the rules
  still apply in full. Keep the diff to what the request and the rules require.
  New programs and design work: write a short plan covering the sections above
  before the code.
