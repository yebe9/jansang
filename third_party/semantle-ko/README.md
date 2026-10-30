# 한국어 의미 유사도의 출처

## semantle-ko

- 공식 저장소: https://github.com/NewsJelly/semantle-ko
- 알고리즘: https://github.com/NewsJelly/semantle-ko/blob/master/word2vec.py
- 원문 정규화/벡터 적재: https://github.com/NewsJelly/semantle-ko/blob/master/process_vecs.py
- 원본 라이선스: GPL-3.0. 원문 전체를 LICENSE.upstream.txt에 보관했다.

잔상의 `dist/semantic-similarity.js`는 위 파일에서 확인한 **실제 단어 벡터의 내적을 두 L2 노름의 곱으로 나눈 코사인 유사도**를 JavaScript로 독립 구현한다. 원본 Python 코드나 데이터베이스 코드는 복사하지 않았다. NFC 정규화도 같은 방식을 따른다. HTTP 서비스나 GPU는 필요하지 않다.

짧은 문장을 비교하는 기능, 알려진 단어 벡터의 평균, 명시적인 한국어 형태 변형, 상위 5개 정렬은 이 프로젝트에서 추가한 확장이다. 원래 꼬맨틀의 문장 이해 기능이라고 표시하지 않는다. 원본 FastText 텍스트 사전에 없는 단어는 측정 불가로 남기며 철자 겹침·랜덤·규칙 기반 점수로 보충하지 않는다.

## 벡터 데이터 (코드 라이선스와 별도)

- 모델: fastText Common Crawl + Wikipedia, Korean, 300 dimensions
- 공식 설명: https://fasttext.cc/docs/en/crawl-vectors.html
- 원본: https://dl.fbaipublicfiles.com/fasttext/vectors-crawl/cc.ko.300.vec.gz
- 저자: Edouard Grave, Piotr Bojanowski, Prakhar Gupta, Armand Joulin, Tomas Mikolov
- 논문: *Learning Word Vectors for 157 Languages*, LREC 2018
- 라이선스: Creative Commons Attribution-ShareAlike 3.0 Unported (CC BY-SA 3.0)
- 라이선스/법률 전문: https://creativecommons.org/licenses/by-sa/3.0/ · https://creativecommons.org/licenses/by-sa/3.0/legalcode

`dist/semantic`의 사전은 빈도 상위 한국어 단어 50,000개와 작품의 춤 표현에 해당하는 실제 벡터를 추출하고, 각 행의 최대 절댓값을 기준으로 int8 양자화한 **변형 데이터셋**이다. 출처·변경 사항·단어 수·차원·SHA-256은 `ko-fasttext.json`에 함께 기록한다. 이 변형 데이터셋도 CC BY-SA 3.0으로 배포한다. 원본 1.27GB 압축 파일은 비공개 `.models` 캐시에 두고 Git에 포함하지 않는다.

## 재생성

```powershell
python scripts/build-korean-vectors.py --download --limit 50000
```

이미 받은 압축 파일을 재사용하려면 `--download`를 생략한다. gzip을 스트리밍으로 읽어 압축 해제본 전체를 디스크에 저장하지 않는다. CPU와 Python 표준 라이브러리만 사용한다.

## 결과 해석

- 표시 값 = 코사인 유사도 × 100. 범위는 -100~100이며 확률이나 의도 일치율이 아니다.
- 문장은 알려진 단어 벡터의 평균이므로 어순, 부정, 복합 문맥에 한계가 있다.
- 제한된 사전과 명시적 형태 변형으로 처리하므로 미등록어가 생길 수 있다. 사용한 단어와 빠진 단어를 함께 반환한다.
- int8 양자화는 작은 수치 오차를 만든다. 브라우저는 각 행을 다시 L2 정규화한다.
- 동음이의어(예: 절도)의 여러 의미를 맥락에 맞게 분리하지 못한다.
- 모델 로딩이 실패하거나 비교할 벡터가 없으면 측정 불가로 표시한다.