import fs from 'node:fs';

const p = 'src/session/models.rs';
let t = fs.readFileSync(p, 'utf8');

const old = `            precision_level: None,
        }`;
const neu = `            precision_level: None,
            char_count: None,
            is_password: None,
            shortcut: None,
        }`;

let count = 0;
while (t.includes(old)) {
  t = t.replace(old, neu);
  count += 1;
}

// Patch new_system to copy keyboard-related fields from input
const from = `            control_name: None,
            automation_id: None,
            control_type: None,
            class_name: None,
            precision_level: None,
            char_count: None,
            is_password: None,
            shortcut: None,
        }
    }
}

pub fn normalize_log_level`;

const to = `            control_name: normalize_optional_string(input.control_name),
            automation_id: normalize_optional_string(input.automation_id),
            control_type: normalize_optional_string(input.control_type),
            class_name: normalize_optional_string(input.class_name),
            precision_level: normalize_optional_string(input.precision_level),
            char_count: input.char_count,
            is_password: input.is_password,
            shortcut: normalize_optional_string(input.shortcut),
        }
    }
}

pub fn normalize_log_level`;

if (!t.includes(from)) {
  // new_system may still be the last occurrence — patch only last block before normalize_log_level
  const idx = t.lastIndexOf(`            control_name: None,
            automation_id: None,
            control_type: None,
            class_name: None,
            precision_level: None,
            char_count: None,
            is_password: None,
            shortcut: None,`);
  if (idx < 0) {
    console.error('could not locate new_system control fields');
    process.exit(1);
  }
  // Only replace the last one (new_system)
  t =
    t.slice(0, idx) +
    `            control_name: normalize_optional_string(input.control_name),
            automation_id: normalize_optional_string(input.automation_id),
            control_type: normalize_optional_string(input.control_type),
            class_name: normalize_optional_string(input.class_name),
            precision_level: normalize_optional_string(input.precision_level),
            char_count: input.char_count,
            is_password: input.is_password,
            shortcut: normalize_optional_string(input.shortcut),` +
    t.slice(idx + `            control_name: None,
            automation_id: None,
            control_type: None,
            class_name: None,
            precision_level: None,
            char_count: None,
            is_password: None,
            shortcut: None,`.length);
  console.log('patched new_system via lastIndex');
} else {
  t = t.replace(from, to);
  console.log('patched new_system via exact block');
}

// Also ensure new_step with_uia and partial constructors that set precision_level: Some still have char fields
// Handle `precision_level: None,\n        };` in tests later

fs.writeFileSync(p, t);
console.log('constructor ends patched', count);
