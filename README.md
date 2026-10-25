# 분실물 센터

학교 분실물을 사진으로 등록·검색하고 반환까지 관리하는 Google Apps Script 웹앱입니다.

- 학생용: https://letter0033-star.github.io/lost-and-found/
- 관리자용: https://letter0033-star.github.io/lost-and-found/admin/

위 두 주소는 짧은 주소용 이동 페이지입니다. 앱은 Google Apps Script에서 실행되고, GitHub Pages는 접속한 사람을 그쪽으로 보내 주기만 합니다.

## 폴더 구성

| 경로 | 내용 |
|---|---|
| `index.html` | 학생용 짧은 주소 → Apps Script 웹앱으로 이동 |
| `admin/index.html` | 관리자용 짧은 주소 → 웹앱 `?page=admin`으로 이동 |
| `src/Code.gs` | 서버 코드 (Apps Script) |
| `src/Index.html` | 학생 조회 화면 템플릿 |
| `src/Admin.html` | 관리자 화면 템플릿 |
| `src/Styles.html` | 공통 디자인 |

`src/` 안의 HTML은 Apps Script 템플릿이라 브라우저에서 직접 열면 화면이 정상적으로 나오지 않습니다.

## 설치

1. Google 스프레드시트를 새로 만들고 **확장 프로그램 → Apps Script**를 엽니다.
2. `src/`의 파일 4개를 같은 이름으로 넣습니다. HTML은 `Index`, `Admin`, `Styles`로 만듭니다.
3. 스프레드시트를 새로고침한 뒤 메뉴 **분실물센터 → ① 초기 설정**을 실행합니다.
4. **배포 → 새 배포 → 웹 앱**을 선택합니다. 실행 사용자는 '나', 액세스 권한은 '모든 사용자'로 둡니다.
5. 발급된 주소를 `index.html`, `admin/index.html` 안의 주소와 바꿉니다.

문제가 생기면 Apps Script 편집기에서 `diagnose` 함수를 실행하고 실행 로그를 확인합니다.

## 보안

- 코드에 비밀번호, 스프레드시트 ID, Drive 폴더 ID가 들어 있지 않습니다. 이런 값은 설치한 사람의 Google 계정 안에만 저장됩니다.
- 비밀번호는 솔트 + SHA-256 해시로 저장합니다.
- 비공개 물품과 사진은 서버가 권한을 확인한 뒤에만 보냅니다.
