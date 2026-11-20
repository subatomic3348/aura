import { useState, type FormEvent } from 'react';
import { prepareEntry } from '../../app/autostart';
import { CODE_LENGTH, formatCode, isValidCode, normalizeCode } from '../../lib/code';
import { navigate } from '../../lib/router';
import { ArrowRight, Broadcast } from '../icons';
import { Button } from '../components/Button';
import { Rings } from '../components/Rings';
import { Shell } from '../components/Shell';
import styles from './Landing.module.css';

export function Landing() {
  const [code, setCode] = useState('');
  const valid = isValidCode(code);

  const join = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    prepareEntry();
    navigate(`/r/${code}`);
  };

  const create = () => {
    prepareEntry();
    navigate('/new');
  };

  return (
    <Shell>
      <div className={`${styles.landing} enter`}>
        <Rings mode="idle" size={88} />
        <div className={styles.text}>
          <h1 className={styles.title}>Listen together, on every device</h1>
          <p className={styles.lead}>
            Start a room and invite nearby phones and laptops with a code. Anyone in the room can share their sound — everyone
            else hears it.
          </p>
        </div>
        <Button variant="primary" size="l" icon={<Broadcast />} className={styles.primary} onClick={create}>
          Start a room
        </Button>
        <div className={styles.divider}>
          <span className="label">or join one</span>
        </div>
        <form className={styles.join} onSubmit={join}>
          <label htmlFor="code" className="visually-hidden">
            Room code
          </label>
          <input
            id="code"
            className={`mono ${styles.codeInput}`}
            value={formatCode(code)}
            onChange={(e) => setCode(normalizeCode(e.currentTarget.value))}
            placeholder="Enter code"
            autoComplete="off"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            maxLength={CODE_LENGTH + 1}
            enterKeyHint="go"
          />
          <Button type="submit" size="l" disabled={!valid} aria-label="Join room">
            <ArrowRight />
          </Button>
        </form>
      </div>
    </Shell>
  );
}
