import { describe, expect, it } from '@effect/vitest'
import { Effect, Option, Stream } from 'effect'
import { deepStrictEqual } from 'node:assert'
import * as LazyRef from './LazyRef'

describe('LazyRef', () => {
  it.effect('allows keeping state with Effect', () =>
    Effect.gen(function* () {
      const ref = yield* LazyRef.make(Effect.succeed(0))

      yield* ref
      yield* LazyRef.update(ref, (x) => x + 1)
      yield* LazyRef.delete(ref)
      yield* ref

      deepStrictEqual(yield* ref, 0)
      deepStrictEqual(yield* LazyRef.update(ref, (x) => x + 1), 1)
      deepStrictEqual(yield* LazyRef.delete(ref), Option.some(1))
      deepStrictEqual(yield* ref, 0)
    }).pipe(Effect.scoped),
  )

  it.effect('allows keeping state with Stream', () =>
    Effect.gen(function* () {
      const ref = yield* LazyRef.make(Stream.succeed(0))

      yield* ref
      yield* LazyRef.update(ref, (x) => x + 1)
      yield* LazyRef.delete(ref)
      yield* ref

      deepStrictEqual(yield* ref, 0)
      deepStrictEqual(yield* LazyRef.update(ref, (x) => x + 1), 1)
      deepStrictEqual(yield* LazyRef.delete(ref), Option.some(1))
      deepStrictEqual(yield* ref, 0)
    }).pipe(Effect.scoped),
  )

  it.live('runUpdates', () =>
    Effect.gen(function* () {
      const ref = yield* LazyRef.of(0)
      const fiber = yield* ref.changes.pipe(Stream.take(10), Stream.runCollect, Effect.fork)
      // Allow fiber to start
      yield* Effect.sleep(0)

      yield* Effect.fork(
        ref.runUpdates(({ get, set }) =>
          Effect.gen(function* () {
            // Preserves ordering of asynchonous updates
            yield* Effect.sleep(100)
            expect(yield* get).toEqual(0)
            expect(yield* set(1)).toEqual(1)
            expect(yield* set(1)).toEqual(1) // prevents duplicates
            expect(yield* set(2)).toEqual(2)
            expect(yield* set(3)).toEqual(3)
            expect(yield* set(4)).toEqual(4)

            return 42
          }),
        ),
      )

      yield* Effect.fork(
        ref.runUpdates(({ get, set }) =>
          Effect.gen(function* (_) {
            expect(yield* _(get)).toEqual(4)
            expect(yield* _(set(5))).toEqual(5)
            expect(yield* _(set(6))).toEqual(6)
            expect(yield* _(set(7))).toEqual(7)
            expect(yield* _(set(8))).toEqual(8)
            expect(yield* _(set(9))).toEqual(9)

            return 99
          }),
        ),
      )

      expect(Array.from(yield* fiber)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    }).pipe(Effect.scoped),
  )

  it.effect('Computed', () =>
    Effect.gen(function* () {
      const ref = yield* LazyRef.of(0)
      const computed = LazyRef.map(ref, (x) => x + 1)
      expect(yield* computed).toEqual(1)

      yield* LazyRef.update(ref, (x) => x + 1)
      expect(yield* computed).toEqual(2)
    }).pipe(Effect.scoped),
  )

  it.effect('struct', () =>
    Effect.gen(function* () {
      const a = yield* LazyRef.of(0)
      const b = yield* LazyRef.of(1)
      const c = yield* LazyRef.of(2)
      const struct = LazyRef.struct({ a, b, c })

      expect(yield* struct).toEqual({ a: 0, b: 1, c: 2 })

      yield* LazyRef.update(a, (x) => x + 1)
      expect(yield* struct).toEqual({ a: 1, b: 1, c: 2 })

      yield* LazyRef.update(b, (x) => x + 1)
      expect(yield* struct).toEqual({ a: 1, b: 2, c: 2 })

      yield* LazyRef.update(c, (x) => x + 1)
      expect(yield* struct).toEqual({ a: 1, b: 2, c: 3 })

      yield* LazyRef.update(struct, (x) => ({ ...x, a: x.a + 1 }))
      expect(yield* struct).toEqual({ a: 2, b: 2, c: 3 })
    }).pipe(Effect.scoped),
  )

  it.effect('struct with computed', () =>
    Effect.gen(function* () {
      const a = yield* LazyRef.of(0)
      const b = yield* LazyRef.of(1)
      const c = LazyRef.map(yield* LazyRef.of(2), (x) => x + 1)
      const struct = LazyRef.struct({ a, b, c })
      expect(yield* struct).toEqual({ a: 0, b: 1, c: 3 })
    }).pipe(Effect.scoped),
  )

  it.effect('tuple', () =>
    Effect.gen(function* () {
      const a = yield* LazyRef.of(0)
      const b = yield* LazyRef.of(1)
      const c = yield* LazyRef.of(2)
      const tuple = LazyRef.tuple(a, b, c)
      expect(yield* tuple).toEqual([0, 1, 2])

      yield* LazyRef.update(a, (x) => x + 1)
      expect(yield* tuple).toEqual([1, 1, 2])

      yield* LazyRef.update(b, (x) => x + 1)
      expect(yield* tuple).toEqual([1, 2, 2])

      yield* LazyRef.update(c, (x) => x + 1)
      expect(yield* tuple).toEqual([1, 2, 3])

      yield* LazyRef.update(tuple, (x) => [x[0] + 1, x[1] + 1, x[2] + 1])
      expect(yield* tuple).toEqual([2, 3, 4])
    }).pipe(Effect.scoped),
  )

  it.effect('tuple with computed', () =>
    Effect.gen(function* () {
      const a = yield* LazyRef.of(0)
      const b = yield* LazyRef.of(1)
      const c = LazyRef.map(yield* LazyRef.of(2), (x) => x + 1)
      const computed = LazyRef.tuple(a, b, c)
      expect(yield* computed).toEqual([0, 1, 3])
    }).pipe(Effect.scoped),
  )

  it.effect('tagged', () => {
    class Foo extends LazyRef.Tag('foo')<Foo, number>() {}
    class Bar extends LazyRef.Tag('bar')<Bar, number>() {}
    const FooBar = LazyRef.struct({ foo: Foo, bar: Bar })

    return Effect.gen(function* () {
      expect(yield* FooBar).toEqual({ foo: 0, bar: 0 })
      yield* LazyRef.update(FooBar, (x) => ({ ...x, foo: x.foo + 1 }))
      yield* LazyRef.update(Bar, (x) => x + 1)
      expect(yield* FooBar).toEqual({ foo: 1, bar: 1 })
      yield* LazyRef.delete(FooBar)
      expect(yield* FooBar).toEqual({ foo: 0, bar: 0 })
    }).pipe(Effect.provide([Foo.of(0), Bar.of(0)]))
  })

  it.live('replays the latest value to late subscribers', () =>
    Effect.gen(function* () {
      const ref = yield* LazyRef.of(0)
      const fiber1 = yield* ref.changes.pipe(Stream.runCollect, Effect.fork)
      const fiber2 = yield* ref.changes.pipe(Stream.runCollect, Effect.delay(250), Effect.fork)
      const fiber3 = yield* ref.changes.pipe(Stream.runCollect, Effect.delay(500), Effect.fork)

      // Update ref 10 times
      yield* Effect.iterate(0, {
        while: (x) => x < 10,
        body: () => LazyRef.update(ref, (y) => y + 1).pipe(Effect.delay(100)),
      }).pipe(
        Effect.onExit(() =>
          Effect.gen(function* () {
            expect(yield* ref.version).toEqual(10)
            yield* ref.awaitShutdown
          }),
        ),
        Effect.fork,
      )

      expect(Array.from(yield* fiber1)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
      expect(Array.from(yield* fiber2)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10])
      expect(Array.from(yield* fiber3)).toEqual([4, 5, 6, 7, 8, 9, 10])
    }).pipe(Effect.scoped),
  )
})
