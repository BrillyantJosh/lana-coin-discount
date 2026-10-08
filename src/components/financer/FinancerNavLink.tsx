/**
 * The way to /financer from the signed-in header — shown only to a financer.
 *
 * Who is one is Direct.Fund's word, read through GET /api/financer/me (signed:
 * the signer is asked about, never a hex the page names). Most people who sign
 * in here are sellers who are still owed, and the link would only lead them to
 * a page that says it is not for them; so it is drawn only on a clear yes, and
 * a refusal, a timeout or Direct.Fund being away draws nothing — a missing
 * link must never stand in the way of the page it sits on.
 *
 * One question per page load and signer: the dashboard re-renders, the answer
 * does not change in that time, and each ask is a call to Direct.Fund.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { financerApi } from '@/lib/financer/financerApi';

const asked = new Map<string, Promise<boolean>>();

/** Is the signed-in key a financer on Direct.Fund? false until (and unless) the answer says yes. */
export function useIsFinancer(): boolean {
  const { session } = useAuth();
  const hex = session?.nostrHexId ?? null;
  const [yes, setYes] = useState(false);
  useEffect(() => {
    if (!hex) {
      setYes(false);
      return;
    }
    let alive = true;
    let answer = asked.get(hex);
    if (!answer) {
      answer = financerApi.me().then((r) => r.data?.isFinancer === true);
      asked.set(hex, answer);
      // A "no" that was only Direct.Fund being away is asked again on the next page load, not remembered as a no.
      void answer.then((v) => {
        if (!v) asked.delete(hex);
      });
    }
    void answer.then((v) => {
      if (alive) setYes(v);
    });
    return () => {
      alive = false;
    };
  }, [hex]);
  return yes;
}

/** Forget what was asked (a test, or a sign-out that leaves the page). */
export function forgetFinancerAnswers(): void {
  asked.clear();
}

export function FinancerNavLink(props: { label: string; className?: string }) {
  const isFinancer = useIsFinancer();
  if (!isFinancer) return null;
  return (
    <Link
      to="/financer"
      className={
        props.className ??
        'rounded-lg border-2 border-primary px-2.5 sm:px-3 py-1 sm:py-1.5 text-xs sm:text-sm font-semibold text-primary hover:bg-accent transition-colors whitespace-nowrap'
      }
    >
      {props.label}
    </Link>
  );
}
