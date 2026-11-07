import Foundation
import Security
import UserNotifications

/// Replaces a push's placeholder alert with the notification's real text before it shows.
///
/// A push carries only ids: the server never hands a title to Expo, Apple or Google. This
/// extension signs in with the app's session grant (read from the shared keychain group),
/// asks our backend for the text (`POST /notifications/push-content`), and rewrites the alert.
/// Any failure, a locked chat, or running out of time leaves the placeholder as it came.
/// Mirrors `src/notifications/push-content.ts`.
final class NotificationService: UNNotificationServiceExtension {
    private let lock = NSLock()
    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var content: UNMutableNotificationContent?
    private var isDelivered = false
    private var fetch: Task<Void, Never>?

    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        guard let content = request.content.mutableCopy() as? UNMutableNotificationContent else {
            contentHandler(request.content)
            return
        }

        self.contentHandler = contentHandler
        self.content = content

        guard let notificationId = PushIds.notificationId(in: request.content.userInfo) else {
            deliver()
            return
        }

        fetch = Task { [weak self] in
            let text = await PushContent.fetch(notificationId: notificationId)

            self?.deliver(text)
        }
    }

    /// The system's budget (about 30 s) is nearly spent: show the placeholder.
    override func serviceExtensionTimeWillExpire() {
        fetch?.cancel()
        deliver()
    }

    private func deliver(_ text: PushContent.Text? = nil) {
        lock.lock()
        defer { lock.unlock() }

        guard !isDelivered, let content, let contentHandler else {
            return
        }

        isDelivered = true

        if let text {
            content.title = text.title
            content.body = text.body
        }

        contentHandler(content)
    }
}

/// The ids Expo puts in a push: under `body` in the APNs payload, or at the top level.
enum PushIds {
    private static let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "_-"))

    static func notificationId(in userInfo: [AnyHashable: Any]) -> String? {
        let candidates: [Any?] = [
            (userInfo["body"] as? [String: Any])?["notificationId"],
            userInfo["notificationId"],
            (userInfo["data"] as? [String: Any])?["notificationId"],
        ]

        for case let id as String in candidates where isId(id) {
            return id
        }

        return nil
    }

    private static func isId(_ value: String) -> Bool {
        !value.isEmpty && value.count <= 64 && value.unicodeScalars.allSatisfy { allowed.contains($0) }
    }
}

enum PushContent {
    struct Text {
        let title: String
        let body: String
    }

    /// Keys of the app's keychain items (`src/auth/secure-store.ts`, `src/notifications/phone-push.ts`).
    private static let grantKey = "neore.mobile.grant"
    private static let lunoraUrlKey = "neore.mobile.lunora-url"

    /// Each request; two of them stay well inside the extension's budget.
    private static let timeout: TimeInterval = 10

    /// The session stored on the phone right now: its token and whose it is. `nil` once signed out
    /// (sign-out clears this item before anything else).
    private static func session() -> (token: String, userId: String)? {
        guard
            let grantData = Keychain.read(grantKey),
            let grant = try? JSONSerialization.jsonObject(with: grantData) as? [String: Any],
            let token = grant["token"] as? String,
            let userId = (grant["user"] as? [String: Any])?["id"] as? String
        else {
            return nil
        }

        return (token, userId)
    }

    static func fetch(notificationId: String) async -> Text? {
        guard
            let fetchedFor = session(),
            let urlData = Keychain.read(lunoraUrlKey),
            let lunoraUrl = String(data: urlData, encoding: .utf8)
        else {
            return nil
        }

        let sessionToken = fetchedFor.token

        guard
            let tokenAnswer = await post(lunoraUrl + "/extension/auth/token", body: ["token": sessionToken], bearer: nil),
            let jwt = tokenAnswer["token"] as? String,
            let content = await post(lunoraUrl + "/notifications/push-content", body: ["notificationId": notificationId], bearer: jwt),
            let title = content["title"] as? String,
            let body = content["body"] as? String
        else {
            // Signed out, offline, too slow, not this account's, or a locked chat (`generic`): keep the placeholder.
            return nil
        }

        // The phone signed out or switched accounts while the text was on its way: it is not this person's to see.
        guard session()?.userId == fetchedFor.userId else {
            return nil
        }

        return Text(title: title, body: body)
    }

    private static func post(_ url: String, body: [String: String], bearer: String?) async -> [String: Any]? {
        guard let endpoint = URL(string: url), endpoint.scheme == "https" || endpoint.host == "localhost" else {
            return nil
        }

        var request = URLRequest(url: endpoint, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)

        request.httpMethod = "POST"
        request.httpShouldHandleCookies = false
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        if let bearer {
            request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
        }

        guard let payload = try? JSONSerialization.data(withJSONObject: body) else {
            return nil
        }

        request.httpBody = payload

        guard
            let (data, response) = try? await URLSession.shared.data(for: request),
            let status = (response as? HTTPURLResponse)?.statusCode,
            (200 ..< 300).contains(status)
        else {
            return nil
        }

        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }
}

/// Reads an item expo-secure-store wrote: a generic password whose account is the key's bytes.
/// No service or group is named, so the search covers every group this extension may read,
/// which is the keychain group it shares with the app.
enum Keychain {
    static func read(_ key: String) -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: Data(key.utf8),
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?

        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess else {
            return nil
        }

        return result as? Data
    }
}
