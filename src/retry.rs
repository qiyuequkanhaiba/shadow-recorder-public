#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RetryFailure<E> {
    pub first: E,
    pub second: E,
}

pub fn run_with_single_retry<T, E, TryOnce, BeforeRetry>(
    mut try_once: TryOnce,
    mut before_retry: BeforeRetry,
) -> Result<T, RetryFailure<E>>
where
    TryOnce: FnMut() -> Result<T, E>,
    BeforeRetry: FnMut(),
{
    match try_once() {
        Ok(value) => Ok(value),
        Err(first) => {
            before_retry();
            match try_once() {
                Ok(value) => Ok(value),
                Err(second) => Err(RetryFailure { first, second }),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use super::run_with_single_retry;

    #[test]
    fn returns_first_success_without_invoking_before_retry() {
        let before_retry_called = Cell::new(0u32);
        let attempts = Cell::new(0u32);

        let result = run_with_single_retry(
            || {
                attempts.set(attempts.get().saturating_add(1));
                Ok::<_, &'static str>(7u32)
            },
            || {
                before_retry_called.set(before_retry_called.get().saturating_add(1));
            },
        );

        assert_eq!(result.ok(), Some(7u32));
        assert_eq!(attempts.get(), 1);
        assert_eq!(before_retry_called.get(), 0);
    }

    #[test]
    fn retries_once_after_first_failure_and_returns_second_success() {
        let before_retry_called = Cell::new(0u32);
        let attempts = Cell::new(0u32);

        let result = run_with_single_retry(
            || {
                let attempt = attempts.get().saturating_add(1);
                attempts.set(attempt);
                if attempt == 1 {
                    Err::<u32, _>("first")
                } else {
                    Ok::<_, &'static str>(11u32)
                }
            },
            || {
                before_retry_called.set(before_retry_called.get().saturating_add(1));
            },
        );

        assert_eq!(result.ok(), Some(11u32));
        assert_eq!(attempts.get(), 2);
        assert_eq!(before_retry_called.get(), 1);
    }

    #[test]
    fn returns_both_errors_when_both_attempts_fail() {
        let before_retry_called = Cell::new(0u32);
        let attempts = Cell::new(0u32);

        let result = run_with_single_retry(
            || {
                let attempt = attempts.get().saturating_add(1);
                attempts.set(attempt);
                if attempt == 1 {
                    Err::<u32, _>("first-error")
                } else {
                    Err::<u32, _>("second-error")
                }
            },
            || {
                before_retry_called.set(before_retry_called.get().saturating_add(1));
            },
        );

        let failure = result.expect_err("expected both attempts to fail");
        assert_eq!(failure.first, "first-error");
        assert_eq!(failure.second, "second-error");
        assert_eq!(attempts.get(), 2);
        assert_eq!(before_retry_called.get(), 1);
    }
}
