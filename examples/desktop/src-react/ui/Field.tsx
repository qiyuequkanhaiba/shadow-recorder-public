import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import clsx from 'clsx';

import styles from './Field.module.css';

export type FieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> & {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  unit?: string;
  layout?: 'vertical' | 'horizontal';
  children?: ReactNode;
};

export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field(
  {
    label,
    hint,
    error,
    unit,
    layout = 'vertical',
    id,
    className,
    children,
    ...inputProps
  },
  ref,
) {
  const autoId = useId();
  const controlId = id ?? autoId;

  return (
    <div
      className={clsx(
        styles.field,
        layout === 'horizontal' && styles.fieldRow,
        className,
      )}
    >
      {label || hint ? (
        <div className={styles.labelGroup}>
          {label ? (
            <label htmlFor={controlId} className={styles.label}>
              {label}
            </label>
          ) : null}
          {hint ? <span className={styles.hint}>{hint}</span> : null}
        </div>
      ) : null}
      <div className={styles.controlWrap}>
        {children ? (
          children
        ) : (
          <>
            <input
              ref={ref}
              id={controlId}
              className={clsx(styles.input, unit && styles.inputWithUnit)}
              {...inputProps}
            />
            {unit ? <span className={styles.unit}>{unit}</span> : null}
          </>
        )}
      </div>
      {error ? <span className={styles.error}>{error}</span> : null}
    </div>
  );
});

export type SelectFieldProps = SelectHTMLAttributes<HTMLSelectElement> & {
  label?: ReactNode;
  hint?: ReactNode;
};

export const SelectField = forwardRef<HTMLSelectElement, SelectFieldProps>(
  function SelectField({ label, hint, id, className, children, ...rest }, ref) {
    const autoId = useId();
    const controlId = id ?? autoId;
    return (
      <div className={clsx(styles.field, className)}>
        {label || hint ? (
          <div className={styles.labelGroup}>
            {label ? (
              <label htmlFor={controlId} className={styles.label}>
                {label}
              </label>
            ) : null}
            {hint ? <span className={styles.hint}>{hint}</span> : null}
          </div>
        ) : null}
        <select ref={ref} id={controlId} className={styles.select} {...rest}>
          {children}
        </select>
      </div>
    );
  },
);

export type TextareaFieldProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  label?: ReactNode;
  hint?: ReactNode;
};

export const TextareaField = forwardRef<HTMLTextAreaElement, TextareaFieldProps>(
  function TextareaField({ label, hint, id, className, ...rest }, ref) {
    const autoId = useId();
    const controlId = id ?? autoId;
    return (
      <div className={clsx(styles.field, className)}>
        {label || hint ? (
          <div className={styles.labelGroup}>
            {label ? (
              <label htmlFor={controlId} className={styles.label}>
                {label}
              </label>
            ) : null}
            {hint ? <span className={styles.hint}>{hint}</span> : null}
          </div>
        ) : null}
        <textarea ref={ref} id={controlId} className={styles.textarea} {...rest} />
      </div>
    );
  },
);

export { styles as fieldStyles };
