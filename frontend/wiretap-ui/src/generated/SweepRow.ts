// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * One length code's result.
 *
 * The echo is compared against the payload the *code* names, not against what
 * was sent, so an endpoint that answered a different length has failed even if
 * every byte it did send was right — which is precisely how a length-versus-
 * code confusion presents.
 */
export type SweepRow = { code: number, expected_len: number, 
/**
 * `None` when nothing came back at all.
 */
received_len: number | null, passed: boolean, };
