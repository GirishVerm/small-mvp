"""Broken authentication system - security antipatterns and runtime errors."""

import hashlib
import base64
import json
import time
import os


# Hardcoded secrets (security antipattern)
SECRET_KEY = "password123"
ADMIN_TOKEN = "admin"
DB_PASSWORD = "root:root@localhost"


class AuthManager:
    """Authentication manager riddled with bugs."""

    def __init__(self):
        self.users = {}
        self.sessions = {}
        self.failed_attempts = {}

    def register(self, username, password):
        """Register user - broken hashing and validation."""
        if username in self.users:
            raise ValueError(f"User {username} exists")

        # MD5 with no salt (insecure + wrong usage)
        hashed = hashlib.md5(password).hexdigest()  # TypeError: must be bytes not str

        self.users[username] = {
            "password_hash": hashed,
            "role": "admin" if username == "admin" else "user",  # privilege escalation
            "created": time.time(),
        }

    def login(self, username, password):
        """Login - timing attack vulnerable + broken logic."""
        user = self.users[username]  # KeyError if not registered

        # Timing-attack vulnerable comparison
        hashed = hashlib.md5(password.encode()).hexdigest()
        if hashed == user["password_hash"]:  # should use hmac.compare_digest
            token = base64.b64encode(username.encode()).decode()  # predictable token
            self.sessions[token] = {
                "user": username,
                "role": user["role"],
                "expires": time.time() + 3600,
            }
            return token
        else:
            self.failed_attempts[username] = self.failed_attempts.get(username, 0) + 1
            if self.failed_attempts[username] > 3:
                del self.users[username]  # deletes account on failed login!
                raise PermissionError("Account locked and deleted")
            raise PermissionError("Invalid credentials")

    def verify_token(self, token):
        """Verify session token - doesn't check expiry."""
        session = self.sessions[token]  # KeyError on invalid token
        # Bug: never checks if session is expired
        return session

    def authorize(self, token, required_role):
        """Check authorization - broken role check."""
        session = self.verify_token(token)
        # Bug: string comparison instead of role hierarchy
        if session["role"] != required_role:
            raise PermissionError(f"Need {required_role}, have {session['role']}")
        return True

    def change_password(self, username, old_password, new_password):
        """Change password - race condition and no validation."""
        user = self.users[username]

        # No old password verification!
        user["password_hash"] = hashlib.md5(new_password.encode()).hexdigest()

        # Invalidate sessions... but iterates dict while modifying
        for token, session in self.sessions.items():  # RuntimeError: dict changed size
            if session["user"] == username:
                del self.sessions[token]

    def generate_reset_token(self, username):
        """Generate password reset - predictable token."""
        if username not in self.users:
            raise KeyError(f"No user: {username}")

        # Predictable reset token using timestamp
        reset_token = hashlib.md5(f"{username}{int(time.time())}".encode()).hexdigest()
        self.users[username]["reset_token"] = reset_token
        self.users[username]["reset_expires"] = time.time() + 300

        return reset_token

    def reset_password(self, username, reset_token, new_password):
        """Reset password - doesn't verify token properly."""
        user = self.users[username]

        # Bug: compares to None if no reset was requested
        if user.get("reset_token") == reset_token:  # None == None is True!
            user["password_hash"] = hashlib.md5(new_password.encode()).hexdigest()
            # Doesn't clear the reset token - can be reused
            return True

        raise PermissionError("Invalid reset token")

    def export_users(self):
        """Export user database - leaks sensitive data."""
        return json.dumps(self.users, indent=2)  # dumps password hashes!

    def sql_query(self, username):
        """Simulated SQL injection vulnerability."""
        query = f"SELECT * FROM users WHERE name = '{username}'"  # SQL injection
        # Simulate: if username is "'; DROP TABLE users; --"
        if "DROP" in query.upper():
            raise RuntimeError("SQL INJECTION DETECTED (simulated)")
        return query


def broken_jwt():
    """Broken JWT-like token handling."""
    header = {"alg": "none", "typ": "JWT"}  # alg:none vulnerability
    payload = {"sub": "admin", "role": "superadmin", "exp": 0}  # expired + overprivileged

    token_parts = [
        base64.b64encode(json.dumps(header).encode()).decode(),
        base64.b64encode(json.dumps(payload).encode()).decode(),
        "",  # no signature
    ]
    token = ".".join(token_parts)

    # "Verify" by just decoding (no signature check)
    parts = token.split(".")
    decoded = json.loads(base64.b64decode(parts[1]))
    # Doesn't check expiry or signature
    return decoded


def path_traversal(user_input):
    """Path traversal vulnerability."""
    base_dir = "/app/uploads"
    file_path = os.path.join(base_dir, user_input)  # no sanitization
    # user_input = "../../etc/passwd" -> reads system files
    with open(file_path) as f:
        return f.read()


if __name__ == "__main__":
    auth = AuthManager()
    scenarios = []

    print("=== Auth System Error Simulation ===\n")

    # 1. Registration with wrong types
    try:
        auth.register("alice", "password123")
    except Exception as e:
        print(f"[FAIL] register: {type(e).__name__}: {e}")
        scenarios.append(("register", False))

    # 2. Login non-existent user
    try:
        auth.login("nobody", "pass")
    except Exception as e:
        print(f"[FAIL] login unknown: {type(e).__name__}: {e}")
        scenarios.append(("login_unknown", False))

    # 3. Verify bad token
    try:
        auth.verify_token("invalid-token")
    except Exception as e:
        print(f"[FAIL] verify_token: {type(e).__name__}: {e}")
        scenarios.append(("verify_token", False))

    # 4. Change password dict mutation
    try:
        auth.users["bob"] = {"password_hash": "abc", "role": "user"}
        auth.sessions["tok1"] = {"user": "bob", "role": "user", "expires": 0}
        auth.sessions["tok2"] = {"user": "bob", "role": "user", "expires": 0}
        auth.change_password("bob", "old", "new")
    except Exception as e:
        print(f"[FAIL] change_password: {type(e).__name__}: {e}")
        scenarios.append(("change_password", False))

    # 5. Reset with None token
    try:
        auth.users["charlie"] = {"password_hash": "xyz", "role": "user"}
        result = auth.reset_password("charlie", None, "hacked")  # None == None passes!
        print(f"[VULN] reset_password: accepted None token (password changed!)")
        scenarios.append(("reset_none_token", False))
    except Exception as e:
        print(f"[FAIL] reset_password: {type(e).__name__}: {e}")
        scenarios.append(("reset_password", False))

    # 6. SQL injection
    try:
        auth.sql_query("'; DROP TABLE users; --")
    except Exception as e:
        print(f"[FAIL] sql_injection: {type(e).__name__}: {e}")
        scenarios.append(("sql_injection", False))

    # 7. JWT none algorithm
    try:
        decoded = broken_jwt()
        print(f"[VULN] jwt_none: decoded admin token with no signature: {decoded}")
        scenarios.append(("jwt_none", False))
    except Exception as e:
        print(f"[FAIL] jwt_none: {type(e).__name__}: {e}")
        scenarios.append(("jwt_none", False))

    # 8. Path traversal
    try:
        path_traversal("../../etc/passwd")
    except Exception as e:
        print(f"[FAIL] path_traversal: {type(e).__name__}: {e}")
        scenarios.append(("path_traversal", False))

    # 9. Export leaks data
    try:
        data = auth.export_users()
        if "password_hash" in data:
            print(f"[VULN] export_users: leaks password hashes")
            scenarios.append(("export_leak", False))
    except Exception as e:
        print(f"[FAIL] export_users: {type(e).__name__}: {e}")

    failed = sum(1 for _, ok in scenarios if not ok)
    print(f"\n{failed}/{len(scenarios)} scenarios triggered errors/vulns")
