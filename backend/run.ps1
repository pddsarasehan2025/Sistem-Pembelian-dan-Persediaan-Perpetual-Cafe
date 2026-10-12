param(
  [int]$Port = 3000,
  [switch]$CheckOnly,
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$FrontendDirectory = Join-Path (Split-Path -Parent $PSScriptRoot) 'frontend'
$MaximumBodyBytes = 1MB
$Utf8 = New-Object System.Text.UTF8Encoding($false)

function Get-BackendSetting {
  param([string]$Name)

  $environmentValue = [Environment]::GetEnvironmentVariable($Name)
  if (-not [string]::IsNullOrWhiteSpace($environmentValue)) {
    return $environmentValue
  }

  $source = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'app.js'))
  $pattern = '(?m)^const ' + [regex]::Escape($Name) + ' = .*?"([^"]+)".*;\r?$'
  $match = [regex]::Match($source, $pattern)
  if (-not $match.Success) {
    throw "Konfigurasi $Name tidak ditemukan di backend/app.js."
  }

  return ConvertFrom-Json -InputObject ('"' + $match.Groups[1].Value + '"')
}

$SupabaseUrl = (Get-BackendSetting 'SUPABASE_URL').TrimEnd('/')
$SupabaseKey = Get-BackendSetting 'SUPABASE_SERVICE_ROLE_KEY'

function Get-SupabaseKeyRole {
  param([string]$Key)
  $keyParts = $Key.Split('.')
  if ($keyParts.Length -ne 3) { return $null }
  try {
    $payload = $keyParts[1].Replace('-', '+').Replace('_', '/')
    while ($payload.Length % 4) { $payload += '=' }
    $claims = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payload)) | ConvertFrom-Json
    return [string]$claims.role
  } catch {
    return $null
  }
}

function Test-SupabaseServerKey {
  param([string]$Key, [string]$Role)
  return ($Role -eq 'service_role' -or $Key.StartsWith('sb_secret_'))
}

$SupabaseKeyRole = Get-SupabaseKeyRole $SupabaseKey
if (-not $CheckOnly -and -not (Test-SupabaseServerKey $SupabaseKey $SupabaseKeyRole)) {
  Write-Output 'Key di backend/app.js adalah key publik (anon/publishable), bukan key server.'
  Write-Output 'Tempel service_role key atau Secret key di prompt berikut. Input tidak akan ditampilkan.'
  $secureKey = Read-Host 'Supabase server key' -AsSecureString
  $keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
  try {
    $SupabaseKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer)
    $secureKey.Dispose()
  }
  $SupabaseKeyRole = Get-SupabaseKeyRole $SupabaseKey
  if (-not (Test-SupabaseServerKey $SupabaseKey $SupabaseKeyRole)) {
    throw 'Key tidak valid. Masukkan service_role key atau Secret key dari Supabase.'
  }
}
if ($SupabaseUrl -notmatch '^https://[a-zA-Z0-9.-]+$') {
  throw 'SUPABASE_URL di backend/app.js tidak valid.'
}
if ([string]::IsNullOrWhiteSpace($SupabaseKey) -or $SupabaseKey.Length -lt 20) {
  throw 'SUPABASE_SERVICE_ROLE_KEY di backend/app.js tidak valid.'
}
if (-not (Test-SupabaseServerKey $SupabaseKey $SupabaseKeyRole)) {
  throw 'Key publik tidak dapat digunakan. Atur service_role key atau Secret key Supabase.'
}
if (-not (Test-Path -LiteralPath (Join-Path $FrontendDirectory 'index.html'))) {
  throw 'Frontend tidak ditemukan. Pastikan folder frontend tetap berada di samping backend.'
}

if ($CheckOnly) {
  Write-Output 'Konfigurasi Supabase dan folder frontend siap.'
  exit 0
}

Add-Type -AssemblyName System.Net.Http
$script:SupabaseHttpClient = New-Object System.Net.Http.HttpClient
$script:SupabaseHttpClient.Timeout = [TimeSpan]::FromSeconds(25)
$script:MimeTypes = @{
  '.html' = 'text/html; charset=utf-8'
  '.css' = 'text/css; charset=utf-8'
  '.js' = 'text/javascript; charset=utf-8'
}

function Send-HttpResponse {
  param(
    [System.IO.Stream]$Stream,
    [int]$Status,
    [string]$ContentType,
    [byte[]]$Body
  )

  $statusText = switch ($Status) {
    200 { 'OK' }
    201 { 'Created' }
    400 { 'Bad Request' }
    404 { 'Not Found' }
    413 { 'Payload Too Large' }
    502 { 'Bad Gateway' }
    default { 'Internal Server Error' }
  }
  $headers = "HTTP/1.1 $Status $statusText`r`n"
  $headers += "Content-Type: $ContentType`r`n"
  $headers += "Content-Length: $($Body.Length)`r`n"
  $headers += "Cache-Control: no-store`r`n"
  $headers += "X-Content-Type-Options: nosniff`r`n"
  $headers += "Connection: close`r`n`r`n"
  $headerBytes = [Text.Encoding]::ASCII.GetBytes($headers)
  $Stream.Write($headerBytes, 0, $headerBytes.Length)
  if ($Body.Length -gt 0) {
    $Stream.Write($Body, 0, $Body.Length)
  }
  $Stream.Flush()
}

function Send-JsonResponse {
  param(
    [System.IO.Stream]$Stream,
    [int]$Status,
    [object]$Data
  )
  $json = ConvertTo-Json -InputObject $Data -Depth 20 -Compress
  $bytes = $Utf8.GetBytes($json)
  Send-HttpResponse $Stream $Status 'application/json; charset=utf-8' $bytes
}

function Read-HttpRequest {
  param([System.IO.Stream]$Stream)

  $headerBuffer = New-Object System.IO.MemoryStream
  $lastBytes = New-Object 'System.Collections.Generic.Queue[byte]'
  while ($headerBuffer.Length -lt 65536) {
    $byte = $Stream.ReadByte()
    if ($byte -lt 0) { throw 'Koneksi terputus sebelum permintaan lengkap.' }
    $headerBuffer.WriteByte([byte]$byte)
    $lastBytes.Enqueue([byte]$byte)
    if ($lastBytes.Count -gt 4) { [void]$lastBytes.Dequeue() }
    if ($lastBytes.Count -eq 4 -and [Text.Encoding]::ASCII.GetString($lastBytes.ToArray()) -eq "`r`n`r`n") { break }
  }

  $headerText = [Text.Encoding]::ASCII.GetString($headerBuffer.ToArray())
  $headerLines = $headerText -split "`r`n"
  if ($headerLines.Count -lt 2) { throw 'Header HTTP tidak valid.' }
  $requestParts = $headerLines[0] -split ' ', 3
  if ($requestParts.Count -lt 2) { throw 'Baris permintaan HTTP tidak valid.' }

  $contentLength = 0
  foreach ($line in $headerLines | Select-Object -Skip 1) {
    if ($line -match '^Content-Length:\s*(\d+)\s*$') {
      $contentLength = [int64]$Matches[1]
    }
  }
  if ($contentLength -gt $MaximumBodyBytes) {
    return @{ Method = $requestParts[0]; Target = $requestParts[1]; Body = $null; TooLarge = $true }
  }

  $bodyBytes = New-Object byte[] ([int]$contentLength)
  $offset = 0
  while ($offset -lt $bodyBytes.Length) {
    $read = $Stream.Read($bodyBytes, $offset, $bodyBytes.Length - $offset)
    if ($read -le 0) { throw 'Isi permintaan tidak lengkap.' }
    $offset += $read
  }
  return @{
    Method = $requestParts[0]
    Target = $requestParts[1]
    Body = $Utf8.GetString($bodyBytes)
    TooLarge = $false
  }
}

function Invoke-SupabaseRequest {
  param(
    [string]$Path,
    [string]$Method = 'GET',
    [object]$Body
  )

  if (-not (Test-SupabaseServerKey $SupabaseKey $SupabaseKeyRole)) {
    throw 'Kunci Supabase di backend/app.js adalah kunci anon, bukan service_role. Ganti dengan service_role/Secret key di backend saja.'
  }

  $request = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::new($Method), "$SupabaseUrl/rest/v1/$Path")
  $request.Headers.Add('apikey', $SupabaseKey)
  $request.Headers.Authorization = New-Object System.Net.Http.Headers.AuthenticationHeaderValue('Bearer', $SupabaseKey)
  if ($null -ne $Body) {
    $json = ConvertTo-Json -InputObject $Body -Depth 20 -Compress
    $request.Content = New-Object System.Net.Http.StringContent($json, $Utf8, 'application/json')
  }
  if ($Method -eq 'POST' -and $Path -notlike 'rpc/*') {
    $request.Headers.Add('Prefer', 'return=representation')
  }

  $response = $script:SupabaseHttpClient.SendAsync($request).GetAwaiter().GetResult()
  $responseText = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
  if (-not $response.IsSuccessStatusCode) {
    $message = "Supabase menolak permintaan ($([int]$response.StatusCode))."
    try {
      $errorBody = ConvertFrom-Json -InputObject $responseText
      if ($errorBody.message) { $message = [string]$errorBody.message }
      elseif ($errorBody.hint) { $message = [string]$errorBody.hint }
    } catch {}
    throw $message
  }
  if ([string]::IsNullOrWhiteSpace($responseText)) { return $null }
  return ConvertFrom-Json -InputObject $responseText
}

function Get-RequiredText {
  param([object]$Value, [string]$Label, [int]$MaximumLength)
  if ($Value -isnot [string] -or [string]::IsNullOrWhiteSpace($Value) -or $Value.Trim().Length -gt $MaximumLength) {
    throw "$Label wajib diisi (maksimal $MaximumLength karakter)."
  }
  return $Value.Trim()
}

function Get-PositiveNumber {
  param([object]$Value, [string]$Label, [bool]$AllowZero = $false)
  $number = 0.0
  $valid = $null -ne $Value -and [double]::TryParse([string]$Value, [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$number)
  if (-not $valid -or [double]::IsNaN($number) -or [double]::IsInfinity($number) -or ($AllowZero -and $number -lt 0) -or (-not $AllowZero -and $number -le 0)) {
    if ($AllowZero) { throw "$Label harus berupa angka nol atau lebih." }
    throw "$Label harus berupa angka lebih dari nol."
  }
  return $number
}

function Get-ValidUuid {
  param([object]$Value, [string]$Label, [bool]$Optional = $false)
  if ($Optional -and [string]::IsNullOrWhiteSpace([string]$Value)) { return $null }
  if ($Value -isnot [string] -or $Value -notmatch '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$') {
    throw "$Label tidak valid."
  }
  return $Value
}

function Handle-ApiRequest {
  param([string]$Method, [string]$Path, [string]$BodyText)

  if ($Method -eq 'GET' -and $Path -eq '/api/persediaan') {
    return Invoke-SupabaseRequest 'ringkasan_persediaan?select=*&order=nama.asc'
  }
  if ($Method -eq 'GET' -and $Path -eq '/api/pemasok') {
    return Invoke-SupabaseRequest 'pemasok?select=id,nama,kontak&order=nama.asc'
  }
  if ($Method -eq 'GET' -and $Path -eq '/api/transaksi') {
    return Invoke-SupabaseRequest 'transaksi_persediaan?select=id,jenis,jumlah,harga_satuan,catatan,dibuat_pada,bahan_baku(nama,satuan),pemasok(nama)&order=dibuat_pada.desc&limit=100'
  }

  if ($Method -ne 'POST') { throw 'Endpoint tidak ditemukan.' }
  try { $body = ConvertFrom-Json -InputObject $BodyText } catch { throw 'Format JSON tidak valid.' }

  if ($Path -eq '/api/bahan-baku') {
    $row = @{
      nama = Get-RequiredText $body.nama 'Nama bahan baku' 100
      satuan = Get-RequiredText $body.satuan 'Satuan' 30
      stok_minimum = Get-PositiveNumber $body.stok_minimum 'Stok minimum' $true
    }
    $result = Invoke-SupabaseRequest 'bahan_baku' 'POST' $row
    return @{ Status = 201; Data = $result[0] }
  }
  if ($Path -eq '/api/pemasok') {
    $contact = $null
    if (-not [string]::IsNullOrWhiteSpace([string]$body.kontak)) {
      $contact = Get-RequiredText $body.kontak 'Kontak' 120
    }
    $row = @{
      nama = Get-RequiredText $body.nama 'Nama pemasok' 120
      kontak = $contact
    }
    $result = Invoke-SupabaseRequest 'pemasok' 'POST' $row
    return @{ Status = 201; Data = $result[0] }
  }
  if ($Path -eq '/api/transaksi') {
    if ($body.jenis -notin @('pembelian', 'pemakaian')) {
      throw 'Jenis transaksi harus pembelian atau pemakaian.'
    }
    $cost = $null
    $supplierId = $null
    if ($body.jenis -eq 'pembelian') {
      $cost = Get-PositiveNumber $body.harga_satuan 'Harga satuan'
      $supplierId = Get-ValidUuid $body.pemasok_id 'Pemasok' $true
    }
    $note = $null
    if (-not [string]::IsNullOrWhiteSpace([string]$body.catatan)) {
      $note = Get-RequiredText $body.catatan 'Catatan' 500
    }
    $rpc = @{
      p_bahan_baku_id = Get-ValidUuid $body.bahan_baku_id 'Bahan baku'
      p_jenis = [string]$body.jenis
      p_jumlah = Get-PositiveNumber $body.jumlah 'Jumlah'
      p_harga_satuan = $cost
      p_pemasok_id = $supplierId
      p_catatan = $note
    }
    $result = Invoke-SupabaseRequest 'rpc/catat_pergerakan_persediaan' 'POST' $rpc
    return @{ Status = 201; Data = @{ id = $result } }
  }
  throw 'Endpoint tidak ditemukan.'
}

function Handle-Client {
  param([System.Net.Sockets.TcpClient]$Client)

  $stream = $Client.GetStream()
  try {
    $incoming = Read-HttpRequest $stream
    if ($incoming.TooLarge) {
      Send-JsonResponse $stream 413 @{ error = 'Ukuran permintaan terlalu besar.' }
      return
    }

    $targetUri = [Uri]::new("http://127.0.0.1$($incoming.Target)")
    $requestPath = [Uri]::UnescapeDataString($targetUri.AbsolutePath)
    if ($incoming.Method -eq 'GET' -and $requestPath -in @('/', '/styles.css', '/app.js')) {
      $fileName = if ($requestPath -eq '/') { 'index.html' } else { $requestPath.TrimStart('/') }
      $filePath = Join-Path $FrontendDirectory $fileName
      $extension = [IO.Path]::GetExtension($filePath)
      $contentType = $script:MimeTypes[$extension]
      $fileBytes = [IO.File]::ReadAllBytes($filePath)
      Send-HttpResponse $stream 200 $contentType $fileBytes
      return
    }

    if ($requestPath.StartsWith('/api/')) {
      try {
        $result = Handle-ApiRequest $incoming.Method $requestPath $incoming.Body
        if ($result -is [hashtable] -and $result.ContainsKey('Status') -and $result.ContainsKey('Data')) {
          Send-JsonResponse $stream $result.Status $result.Data
        } else {
          Send-JsonResponse $stream 200 $result
        }
      } catch {
        $message = $_.Exception.Message
        $status = 400
        if ($message -eq 'Endpoint tidak ditemukan.') { $status = 404 }
        elseif ($message.StartsWith('Supabase menolak permintaan') -or $message.StartsWith('Kunci Supabase')) {
          $status = 502
          Write-Host $message
        }
        Send-JsonResponse $stream $status @{ error = $message }
      }
      return
    }

    Send-JsonResponse $stream 404 @{ error = 'Halaman tidak ditemukan.' }
  } finally {
    $stream.Dispose()
    $Client.Dispose()
  }
}

$listener = New-Object System.Net.Sockets.TcpListener([Net.IPAddress]::Loopback, $Port)
try {
  $listener.Start()
  Write-Output "Tentang Kita siap di http://127.0.0.1:$Port"
  if (-not $NoBrowser) {
    Start-Process "http://127.0.0.1:$Port"
  }
  while ($listener.Server.IsBound) {
    $client = $listener.AcceptTcpClient()
    Handle-Client $client
  }
} finally {
  $listener.Stop()
  $script:SupabaseHttpClient.Dispose()
}
