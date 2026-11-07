import Foundation
import Security

// Secret input/output is only via pipes owned by the launcher, never command arguments.
let args = CommandLine.arguments
guard args.count == 3, ["get", "put", "delete"].contains(args[1]),
      args[2].range(of: "^[A-Za-z0-9_]{3,100}$", options: .regularExpression) != nil else {
    FileHandle.standardError.write(Data("Usage: keychain-helper get|put|delete BOT_USERNAME\n".utf8))
    exit(64)
}
let query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: "org.local-image-search.bot-token",
    kSecAttrAccount as String: args[2].lowercased(),
]
func fail(_ status: OSStatus) -> Never {
    // Distinguish missing item from access denied; never overwrite after a denied read.
    if status == errSecItemNotFound { exit(44) }
    FileHandle.standardError.write(Data("KEYCHAIN_ERROR status=\(status)\n".utf8))
    exit(45)
}
switch args[1] {
case "get":
    var match = query
    match[kSecReturnData as String] = true
    match[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(match as CFDictionary, &result)
    guard status == errSecSuccess else { fail(status) }
    guard let data = result as? Data, !data.isEmpty else { exit(46) }
    FileHandle.standardOutput.write(data)
case "put":
    let data = FileHandle.standardInput.readDataToEndOfFile()
    guard let token = String(data: data, encoding: .utf8), !token.isEmpty,
          token.count <= 512, token.rangeOfCharacter(from: .whitespacesAndNewlines) == nil else { exit(64) }
    let changes = [kSecValueData as String: data]
    var status = SecItemUpdate(query as CFDictionary, changes as CFDictionary)
    if status == errSecItemNotFound {
        var item = query
        item[kSecValueData as String] = data
        item[kSecAttrLabel as String] = "Telegram image search: \(args[2])"
        status = SecItemAdd(item as CFDictionary, nil)
    }
    guard status == errSecSuccess else { fail(status) }
case "delete":
    let status = SecItemDelete(query as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else { fail(status) }
default: exit(64)
}
