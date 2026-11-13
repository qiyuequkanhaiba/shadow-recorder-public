import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import clsx from 'clsx';

import styles from './IconButton.module.css';

export type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'> & {
  'aria-label': string;
  size?: 'sm' | 'md';
  variant?: 'default' | 'ghost';
  active?: boolean;
  children: ReactNode;
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    size = 'md',
    variant = 'default',
    active = false,
    className,
    type = 'button',
    children,
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={clsx(
        styles.iconButton,
        size === 'sm' ? styles.sizeSm : styles.sizeMd,
        variant === 'ghost' && styles.variantGhost,
        active && styles.active,
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
});
