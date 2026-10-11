// ui/src/hooks/useAsyncAnswer.ts

import { useEffect, useState, type DependencyList } from "react";
import { tlog } from "../api/settings";

/** What `ask` last answered for `deps`, `initial` until it first answers; an answer to superseded deps is dropped. */
export function useAsyncAnswer<T>(ask: () => Promise<T>, deps: DependencyList, initial: T): T {
  const [answer, setAnswer] = useState(initial);
  useEffect(() => {
    let current = true;
    ask()
      .then((next) => {
        if (current) setAnswer(next);
      })
      .catch((e) => tlog.info(`[useAsyncAnswer] ${e}`));
    return () => {
      current = false;
    };
    // `deps` names every input `ask` reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return answer;
}
