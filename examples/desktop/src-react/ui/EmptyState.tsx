import type { HTMLAttributes, ReactNode } from 'react';
import clsx from 'clsx';

import styles from './EmptyState.module.css';

export type EmptyStateProps = Omit<HTMLAttributes<HTMLDivElement>, 'title'> & {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  tone?: 'default' | 'danger';
};

export function EmptyState({
  icon,
  title,
  description,
  action,
  tone = 'default',
  className,
  ...rest
}: EmptyStateProps) {
  return (
    <div
      className={clsx(
        styles.emptyState,
        tone === 'danger' && styles.toneDanger,
        className,
      )}
      {...rest}
    >
      {icon ? (
        <span className={styles.icon} aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <p className={styles.title}>{title}</p>
      {description ? <p className={styles.description}>{description}</p> : null}
      {action ? <div className={styles.action}>{action}</div> : null}
    </div>
  );
}
